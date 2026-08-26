"use client";

import {
  BACKGROUND_PULL_TABLES,
  attendanceId,
  type AuditLogEntry,
  type PullTable,
  type SyncCursor,
  type UserContext,
} from "@/lib/domain";
import {
  getDatabase,
  type AttendanceDatabase,
} from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  fromCloudRecord,
  type LocalPullRecord,
} from "@/lib/sync/serialization";

const PAGE_SIZE = 500;

const PULL_COLUMNS: Record<PullTable, string> = {
  organizations:
    "id,name,slug,created_by,created_at,updated_at,version",
  profiles:
    "id,organization_id,display_name,role,is_active,theme_preference,can_reopen_completed_services,version,created_at,updated_at",
  organization_settings:
    "id,organization_id,settings,version,created_by,updated_by,created_at,updated_at",
  people:
    "id,organization_id,first_name,last_name,display_name,person_type,is_active,duplicate_name_allowed,email,phone,inactive_at,restored_at,deleted_at,merged_into_id,merged_from_ids,version,created_by,updated_by,created_at,updated_at",
  member_private_details:
    "id,organization_id,member_id,notes,version,created_by,updated_by,created_at,updated_at",
  services:
    "id,organization_id,service_date,service_type,custom_name,service_time,notes,status,unnamed_visitor_count,sunday_school_kids_count,is_archived,deleted_at,version,created_by,updated_by,created_at,updated_at",
  service_attendance:
    "id,organization_id,service_id,person_id,present,version,created_by,updated_by,created_at,updated_at",
  service_visitors:
    "id,organization_id,service_id,first_name,last_name,display_name,saved_as_member,member_person_id,notes,deleted_at,version,created_by,updated_by,created_at,updated_at",
  audit_log:
    "id,organization_id,entity_type,entity_id,action,user_id,user_display_name,role,occurred_at,device_id,details,created_at,updated_at",
};

type LocalStore =
  | "organizations"
  | "organizationSettings"
  | "profiles"
  | "people"
  | "memberPrivateDetails"
  | "services"
  | "attendance"
  | "visitors"
  | "auditLog";

export interface PullPage {
  rows: Record<string, unknown>[];
  hasMore: boolean;
}

export interface PullSource {
  fetchPage(
    table: PullTable,
    organizationId: string,
    updatedAt: string | undefined,
    offset: number,
    limit: number,
    recordId?: string,
  ): Promise<PullPage>;
}

export interface PullResult {
  downloaded: number;
  merged: number;
  skippedPending: number;
  skippedOlder: number;
}

function storeFor(table: PullTable): LocalStore {
  if (table === "service_attendance") return "attendance";
  if (table === "service_visitors") return "visitors";
  if (table === "organization_settings") return "organizationSettings";
  if (table === "member_private_details") return "memberPrivateDetails";
  if (table === "audit_log") return "auditLog";
  return table;
}

function cursorId(userId: string, organizationId: string, table: PullTable) {
  return `${userId}:${organizationId}:${table}`;
}

function recordUpdatedAt(record: LocalPullRecord) {
  return record.updatedAt;
}

function recordOrganizationId(record: LocalPullRecord, table: PullTable) {
  return table === "organizations" ? record.id : "organizationId" in record ? record.organizationId : "";
}

function canonicalize(record: LocalPullRecord, table: PullTable) {
  if (table !== "service_attendance") return record;
  if (!("serviceId" in record) || !("personId" in record)) return record;
  return { ...record, id: attendanceId(record.serviceId, record.personId) };
}

async function putLocalRecord(
  database: Awaited<ReturnType<typeof getDatabase>>,
  store: LocalStore,
  record: LocalPullRecord,
) {
  switch (store) {
    case "organizations":
      return database.put(
        "organizations",
        record as AttendanceDatabase["organizations"]["value"],
      );
    case "organizationSettings":
      return database.put(
        "organizationSettings",
        record as AttendanceDatabase["organizationSettings"]["value"],
      );
    case "profiles":
      return database.put("profiles", record as AttendanceDatabase["profiles"]["value"]);
    case "people":
      return database.put("people", record as AttendanceDatabase["people"]["value"]);
    case "memberPrivateDetails":
      return database.put(
        "memberPrivateDetails",
        record as AttendanceDatabase["memberPrivateDetails"]["value"],
      );
    case "services":
      return database.put("services", record as AttendanceDatabase["services"]["value"]);
    case "attendance":
      return database.put(
        "attendance",
        record as AttendanceDatabase["attendance"]["value"],
      );
    case "visitors":
      return database.put("visitors", record as AttendanceDatabase["visitors"]["value"]);
    case "auditLog":
      {
        const auditEntry = record as AuditLogEntry;
        if (
          auditEntry.entityType === "user" &&
          auditEntry.action === "deleted" &&
          auditEntry.details?.historyDeleted === true
        ) {
          const cached = await database.getAllFromIndex(
            "auditLog",
            "organizationId",
            auditEntry.organizationId,
          );
          const transaction = database.transaction("auditLog", "readwrite");
          for (const entry of cached) {
            if (entry.userId === auditEntry.entityId) {
              await transaction.store.delete(entry.id);
            }
          }
          await transaction.done;
        }
      }
      return database.put(
        "auditLog",
        record as AttendanceDatabase["auditLog"]["value"],
      );
  }
}

export function createSupabasePullSource(): PullSource {
  return {
    async fetchPage(
      table,
      organizationId,
      updatedAt,
      offset,
      limit,
      recordId,
    ) {
      let query = getSupabaseClient()
        .from(table)
        .select(PULL_COLUMNS[table])
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true });
      query =
        table === "organizations"
          ? query.eq("id", organizationId)
          : query.eq("organization_id", organizationId);
      if (updatedAt && recordId) {
        query = query.or(
          `updated_at.gt.${updatedAt},and(updated_at.eq.${updatedAt},id.gt.${recordId})`,
        );
      } else if (updatedAt) {
        // Legacy cursors did not store the final record ID. Use one inclusive
        // boundary request, then persist the composite cursor so subsequent
        // pulls download only records strictly after the last received row.
        query = query.gte("updated_at", updatedAt);
      }
      const { data, error } = await query.range(offset, offset + limit - 1);
      if (error) {
        throw new Error(
          `${table}: ${error.code ? `${error.code}: ` : ""}${error.message}`,
        );
      }
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      return { rows, hasMore: rows.length === limit };
    },
  };
}

export async function pullOrganizationData(
  userOrOrganization: UserContext | string,
  source: PullSource = createSupabasePullSource(),
  options: {
    fullSnapshot?: boolean;
    tables?: readonly PullTable[];
    onRemoteChangesDetected?: () => void;
  } = {},
): Promise<PullResult> {
  const organizationId =
    typeof userOrOrganization === "string"
      ? userOrOrganization
      : userOrOrganization.organizationId;
  const userId =
    typeof userOrOrganization === "string"
      ? "legacy"
      : userOrOrganization.userId;
  const database = await getDatabase();
  const queue = await database.getAllFromIndex(
    "syncQueue",
    "organizationId",
    organizationId,
  );
  const pending = new Map(
    queue.map((item) => [`${item.table}:${item.recordId}`, item]),
  );
  const result: PullResult = {
    downloaded: 0,
    merged: 0,
    skippedPending: 0,
    skippedOlder: 0,
  };

  const requestedTables = options.tables ?? BACKGROUND_PULL_TABLES;
  let remoteChangesDetected = false;
  for (const table of requestedTables) {
    const scopedCursorId = cursorId(userId, organizationId, table);
    const existingCursor = await database.get(
      "syncCursors",
      scopedCursorId,
    );
    const cursor = options.fullSnapshot ? undefined : existingCursor;
    let offset = 0;
    let newestUpdatedAt = cursor?.updatedAt;
    let newestRecordId = cursor?.recordId;

    while (true) {
      const page = await source.fetchPage(
        table,
        organizationId,
        cursor?.updatedAt,
        offset,
        PAGE_SIZE,
        cursor?.recordId,
      );
      if (page.rows.length > 0 && !remoteChangesDetected) {
        remoteChangesDetected = true;
        options.onRemoteChangesDetected?.();
      }
      result.downloaded += page.rows.length;

      for (const row of page.rows) {
        const record = canonicalize(fromCloudRecord(table, row), table);
        if (recordOrganizationId(record, table) !== organizationId) {
          throw new Error(`${table}: organization isolation check failed.`);
        }
        const store = storeFor(table);
        const pendingKey = `${table}:${record.id}`;
        const pendingMutation = pending.get(pendingKey);
        if (pendingMutation) {
          // Completion is a one-way lifecycle advancement unless an Admin
          // deliberately reopens the current server version. If another
          // device completed a service after this mutation's base version,
          // retain all pending fields but prevent the stale payload from
          // reverting the organization-wide service to Draft.
          if (
            table === "services" &&
            "status" in record &&
            record.status === "completed" &&
            typeof record.version === "number" &&
            record.version > (pendingMutation.baseVersion ?? 0)
          ) {
            const local = await database.get("services", record.id);
            if (local?.status === "draft") {
              await database.put("services", {
                ...local,
                status: "completed",
                version: record.version,
                updatedAt: record.updatedAt,
                updatedBy:
                  "updatedBy" in record && typeof record.updatedBy === "string"
                    ? record.updatedBy
                    : local.updatedBy,
              });
              await database.put("syncQueue", {
                ...pendingMutation,
                baseVersion: record.version,
                payload: {
                  ...pendingMutation.payload,
                  status: "completed",
                  version: record.version,
                  updated_at: record.updatedAt,
                },
              });
              result.merged += 1;
            }
          }
          result.skippedPending += 1;
        } else {
          // A queued write is the only trustworthy indication that a local
          // record is newer. Without one, Supabase is authoritative because
          // its trigger owns updated_at; a device clock must never outrank it.
          await putLocalRecord(database, store, record);
          result.merged += 1;
        }
        const cloudRecordId = String(row.id);
        const updatedAt = recordUpdatedAt(record);
        if (
          !newestUpdatedAt ||
          updatedAt > newestUpdatedAt ||
          (updatedAt === newestUpdatedAt &&
            (!newestRecordId || cloudRecordId > newestRecordId))
        ) {
          newestUpdatedAt = updatedAt;
          newestRecordId = cloudRecordId;
        }
      }

      if (!page.hasMore) break;
      offset += PAGE_SIZE;
    }

    const durableUpdatedAt =
      newestUpdatedAt ?? cursor?.updatedAt ?? "1970-01-01T00:00:00.000Z";
    if (durableUpdatedAt) {
      const cursor: SyncCursor = {
        id: scopedCursorId,
        userId,
        organizationId,
        table,
        updatedAt: durableUpdatedAt,
        recordId: newestRecordId,
        lastSuccessfulPullAt: new Date().toISOString(),
      };
      await database.put("syncCursors", cursor);
    }
  }

  if (result.merged > 0) announceDataChanged();
  return result;
}
