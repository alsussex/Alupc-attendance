"use client";

import {
  PULL_TABLES,
  attendanceId,
  type PullTable,
  type SyncCursor,
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

type LocalStore =
  | "organizations"
  | "organizationSettings"
  | "profiles"
  | "people"
  | "services"
  | "attendance"
  | "visitors";

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
  return table;
}

function cursorId(organizationId: string, table: PullTable) {
  return `${organizationId}:${table}`;
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
    case "services":
      return database.put("services", record as AttendanceDatabase["services"]["value"]);
    case "attendance":
      return database.put(
        "attendance",
        record as AttendanceDatabase["attendance"]["value"],
      );
    case "visitors":
      return database.put("visitors", record as AttendanceDatabase["visitors"]["value"]);
  }
}

export function createSupabasePullSource(): PullSource {
  return {
    async fetchPage(table, organizationId, updatedAt, offset, limit) {
      let query = getSupabaseClient()
        .from(table)
        .select("*")
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true });
      query =
        table === "organizations"
          ? query.eq("id", organizationId)
          : query.eq("organization_id", organizationId);
      if (updatedAt) query = query.gte("updated_at", updatedAt);
      const { data, error } = await query.range(offset, offset + limit - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = (data ?? []) as Record<string, unknown>[];
      return { rows, hasMore: rows.length === limit };
    },
  };
}

export async function pullOrganizationData(
  organizationId: string,
  source: PullSource = createSupabasePullSource(),
): Promise<PullResult> {
  const database = await getDatabase();
  const queue = await database.getAllFromIndex(
    "syncQueue",
    "organizationId",
    organizationId,
  );
  const pending = new Set(queue.map((item) => `${item.table}:${item.recordId}`));
  const result: PullResult = {
    downloaded: 0,
    merged: 0,
    skippedPending: 0,
    skippedOlder: 0,
  };

  for (const table of PULL_TABLES) {
    const existingCursor = await database.get(
      "syncCursors",
      cursorId(organizationId, table),
    );
    let offset = 0;
    let newestUpdatedAt = existingCursor?.updatedAt;

    while (true) {
      const page = await source.fetchPage(
        table,
        organizationId,
        existingCursor?.updatedAt,
        offset,
        PAGE_SIZE,
      );
      result.downloaded += page.rows.length;

      for (const row of page.rows) {
        const record = canonicalize(fromCloudRecord(table, row), table);
        if (recordOrganizationId(record, table) !== organizationId) {
          throw new Error(`${table}: organization isolation check failed.`);
        }
        const store = storeFor(table);
        const pendingKey = `${table}:${record.id}`;
        if (pending.has(pendingKey)) {
          result.skippedPending += 1;
          continue;
        }

        // A queued write is the only trustworthy indication that a local record
        // is newer. Without one, Supabase is authoritative because its trigger
        // owns updated_at; a device clock must never outrank the server clock.
        await putLocalRecord(database, store, record);
        result.merged += 1;
        if (
          !newestUpdatedAt ||
          Date.parse(recordUpdatedAt(record)) > Date.parse(newestUpdatedAt)
        ) {
          newestUpdatedAt = recordUpdatedAt(record);
        }
      }

      if (!page.hasMore) break;
      offset += PAGE_SIZE;
    }

    if (newestUpdatedAt) {
      const cursor: SyncCursor = {
        id: cursorId(organizationId, table),
        organizationId,
        table,
        updatedAt: newestUpdatedAt,
        lastSuccessfulPullAt: new Date().toISOString(),
      };
      await database.put("syncCursors", cursor);
    }
  }

  announceDataChanged();
  return result;
}
