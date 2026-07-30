"use client";

import type { SyncQueueItem, VisitorSyncConflict } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { getSupabaseClient } from "@/lib/supabase/client";
import { reconcileAttendanceMutation } from "@/lib/sync/attendance-conflicts";
import { reconcileVisitorMutation } from "@/lib/sync/visitor-conflicts";
import { humanReadableSyncError } from "@/lib/sync/errors";

export interface UploadTarget {
  upsert(
    table: SyncQueueItem["table"],
    payload: Record<string, unknown>,
    onConflict: string,
    context?: {
      organizationId: string;
      recordId: string;
      expectedVersion?: number;
      basePayload?: Record<string, unknown>;
      mutationToken: string;
      legacyMutation?: boolean;
    },
  ): Promise<UploadReceipt | void>;
}

export interface UploadReceipt {
  version: number;
  updatedAt?: string;
}

export interface UploadResult {
  uploaded: number;
  errors: string[];
  diagnostics?: string[];
  blockedConflicts: number;
}

export type SyncTrigger =
  | "automatic"
  | "manual"
  | "startup"
  | "focus"
  | "online"
  | "scheduled"
  | "remote";

interface UploadExecutionOptions {
  trigger?: SyncTrigger;
  timeoutMs?: number;
}

interface DynamicSupabaseResult {
  data: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
}

interface DynamicSupabaseQuery {
  eq(column: string, value: unknown): DynamicSupabaseQuery;
  select(columns: string): DynamicSupabaseQuery;
  maybeSingle(): Promise<DynamicSupabaseResult>;
  single(): Promise<DynamicSupabaseResult>;
}

interface DynamicSupabaseTable {
  select(columns: string): DynamicSupabaseQuery;
  update(payload: Record<string, unknown>): DynamicSupabaseQuery;
  upsert(
    payload: Record<string, unknown>,
    options: { onConflict: string },
  ): DynamicSupabaseQuery;
}

interface DynamicSupabaseClient {
  from(name: string): DynamicSupabaseTable;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<DynamicSupabaseResult>;
}

class SupabaseUploadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SupabaseUploadError";
  }
}

export class SynchronizationConflictError extends Error {
  readonly code = "SYNC_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SynchronizationConflictError";
  }
}

export class VisitorSynchronizationConflictError extends SynchronizationConflictError {
  constructor(readonly conflict: VisitorSyncConflict) {
    super(
      `${conflict.visitorName} has changes from another device. Review them before finishing this service.`,
    );
    this.name = "VisitorSynchronizationConflictError";
  }
}

export class AttendanceSynchronizationConflictError extends SynchronizationConflictError {
  constructor(recordId: string) {
    super(
      `Attendance ${recordId} has a different checkbox state on another device. The local change remains safely queued for review.`,
    );
    this.name = "AttendanceSynchronizationConflictError";
  }
}

const UPLOAD_ORDER: SyncQueueItem["table"][] = [
  "organizations",
  "organization_settings",
  "people",
  "member_private_details",
  "services",
  "service_attendance",
  "service_visitors",
  "audit_log",
];

function uploadRank(item: SyncQueueItem) {
  if (
    item.table === "services" &&
    item.payload.status === "completed" &&
    typeof item.baseVersion === "number"
  ) {
    return UPLOAD_ORDER.length;
  }
  return UPLOAD_ORDER.indexOf(item.table);
}

export function createSupabaseUploadTarget(): UploadTarget {
  return {
    async upsert(table, payload, onConflict, context) {
      const tableName: string = table;
      if (!context) {
        const { error } = await getSupabaseClient()
          .from(tableName)
          .upsert(payload, { onConflict });
        if (error) throw new SupabaseUploadError(error.message, error.code);
        return;
      }

      const mutationPayload = {
        ...payload,
        last_mutation_id: context.mutationToken,
      };
      const client = getSupabaseClient() as unknown as DynamicSupabaseClient;

      // Audit history is append-only and Attendance Takers intentionally cannot
      // read it. Sending it through the editable-record SELECT/UPSERT path would
      // require permissions that no audit writer should need. The RPC derives
      // the actor and organization from auth.uid(), and safely acknowledges an
      // already-applied mutation without exposing audit rows to the caller.
      if (table === "audit_log") {
        const { data, error } = await client.rpc("append_audit_log_entry", {
          p_entry: payload,
          p_mutation_id: context.mutationToken,
        });
        if (error) throw new SupabaseUploadError(error.message, error.code);
        return {
          version:
            typeof data?.version === "number" ? Number(data.version) : 1,
          updatedAt:
            typeof data?.updated_at === "string"
              ? data.updated_at
              : undefined,
        };
      }

      const applyIdentity = (query: DynamicSupabaseQuery) => {
        if (table === "service_attendance") {
          return query
            .eq("organization_id", context.organizationId)
            .eq("service_id", payload.service_id)
            .eq("person_id", payload.person_id);
        }
        return query.eq("id", context.recordId);
      };

      if (typeof context.expectedVersion === "number") {
        const query = applyIdentity(
          client.from(tableName).update(mutationPayload),
        ).eq("version", context.expectedVersion);
        const { data, error } = await query
          .select("version,updated_at,last_mutation_id")
          .maybeSingle();
        if (error) throw new SupabaseUploadError(error.message, error.code);
        if (data) {
          return {
            version: Number(data.version),
            updatedAt:
              typeof data.updated_at === "string"
                ? data.updated_at
                : undefined,
          };
        }
      }

      const currentQuery = applyIdentity(
        client
          .from(tableName)
          .select(
            table === "service_attendance"
              ? "version,updated_at,created_at,last_mutation_id,present"
              : "version,updated_at,created_at,last_mutation_id",
          ),
      );
      const { data: current, error: currentError } =
        await currentQuery.maybeSingle();
      if (currentError) {
        throw new SupabaseUploadError(currentError.message, currentError.code);
      }
      if (current) {
        if (current.last_mutation_id === context.mutationToken) {
          return {
            version: Number(current.version),
            updatedAt:
              typeof current.updated_at === "string"
                ? current.updated_at
                : undefined,
          };
        }
        if (table === "service_attendance") {
          const reconciliation = reconcileAttendanceMutation(
            mutationPayload,
            context.basePayload,
            current,
          );
          if (reconciliation.kind === "satisfied") {
            return {
              version: Number(current.version),
              updatedAt:
                typeof current.updated_at === "string"
                  ? current.updated_at
                  : undefined,
            };
          }
          if (reconciliation.kind === "conflict") {
            throw new AttendanceSynchronizationConflictError(
              context.recordId,
            );
          }
          const { data: attendanceData, error: attendanceError } =
            await applyIdentity(
              client.from(tableName).update({
                ...mutationPayload,
                last_mutation_id: context.mutationToken,
              }),
            )
              .eq("version", current.version)
              .select("version,updated_at,last_mutation_id")
              .maybeSingle();
          if (attendanceError) {
            throw new SupabaseUploadError(
              attendanceError.message,
              attendanceError.code,
            );
          }
          if (!attendanceData) {
            throw new AttendanceSynchronizationConflictError(
              context.recordId,
            );
          }
          return {
            version: Number(attendanceData.version),
            updatedAt:
              typeof attendanceData.updated_at === "string"
                ? attendanceData.updated_at
                : undefined,
          };
        }
        if (table === "service_visitors") {
          const reconciliation = reconcileVisitorMutation(
            mutationPayload,
            context.basePayload,
            current,
          );
          if (reconciliation.kind === "satisfied") {
            return {
              version: Number(current.version),
              updatedAt:
                typeof current.updated_at === "string"
                  ? current.updated_at
                  : undefined,
            };
          }
          if (reconciliation.kind === "conflict") {
            throw new VisitorSynchronizationConflictError(
              reconciliation.conflict,
            );
          }
          const { data: mergedData, error: mergedError } = await applyIdentity(
            client.from(tableName).update({
              ...reconciliation.payload,
              last_mutation_id: context.mutationToken,
            }),
          )
            .eq("version", current.version)
            .select("version,updated_at,last_mutation_id")
            .maybeSingle();
          if (mergedError) {
            throw new SupabaseUploadError(
              mergedError.message,
              mergedError.code,
            );
          }
          if (!mergedData) {
            throw new SynchronizationConflictError(
              `${table}:${context.recordId} changed while visitor fields were being merged. The merged change remains safely queued.`,
            );
          }
          return {
            version: Number(mergedData.version),
            updatedAt:
              typeof mergedData.updated_at === "string"
                ? mergedData.updated_at
                : undefined,
          };
        }
        if (
          Number(current.version) === 1 &&
          (context.legacyMutation ||
            (typeof payload.created_at === "string" &&
              payload.created_at === current.created_at))
        ) {
          const { data: legacyData, error: legacyError } = await client
            .from(tableName)
            .upsert(mutationPayload, { onConflict })
            .select("version,updated_at")
            .single();
          if (legacyError) {
            throw new SupabaseUploadError(
              legacyError.message,
              legacyError.code,
            );
          }
          if (!legacyData) {
            throw new Error(
              "Legacy synchronization returned no server receipt.",
            );
          }
          return {
            version: Number(legacyData.version),
            updatedAt:
              typeof legacyData.updated_at === "string"
                ? legacyData.updated_at
                : undefined,
          };
        }
        throw new SynchronizationConflictError(
          `${table}:${context.recordId} changed on another device. The local change remains safely queued.`,
        );
      }

      const { data, error } = await client
        .from(tableName)
        .upsert(mutationPayload, { onConflict })
        .select("version,updated_at")
        .single();
      if (error) throw new SupabaseUploadError(error.message, error.code);
      if (!data) {
        throw new Error("Synchronization upload returned no server receipt.");
      }
      return {
        version: Number(data.version),
        updatedAt:
          typeof data.updated_at === "string" ? data.updated_at : undefined,
      };
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synchronization request timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function uploadPendingChanges(
  organizationId: string,
  target: UploadTarget = createSupabaseUploadTarget(),
  options: UploadExecutionOptions = {},
): Promise<UploadResult> {
  const database = await getDatabase();
  const queue = (await database.getAll("syncQueue"))
    .filter((item) => item.organizationId === organizationId)
    .sort(
      (a, b) =>
        uploadRank(a) - uploadRank(b) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const result: UploadResult = {
    uploaded: 0,
    errors: [],
    diagnostics: [],
    blockedConflicts: 0,
  };
  const visibleErrors = new Set<string>();
  const servicesWithVisitorConflicts = new Set(
    queue
      .filter(
        (item) =>
          item.table === "service_visitors" &&
          item.status === "conflict" &&
          item.conflict?.serviceId,
      )
      .map((item) => item.conflict!.serviceId),
  );

  for (const item of queue) {
    if (item.status === "conflict") {
      result.blockedConflicts += 1;
      const conflictMessage =
        item.conflict
          ? `${item.conflict.visitorName} has changes from another device. Review them before finishing this service.`
          : humanReadableSyncError({
              item,
              message:
                item.lastError ??
                "This change conflicts with a newer server record.",
              code: "SYNC_CONFLICT",
            });
      if (!visibleErrors.has(conflictMessage)) {
        visibleErrors.add(conflictMessage);
        result.errors.push(conflictMessage);
      }
      result.diagnostics?.push(
        item.lastError ?? `SYNC_CONFLICT: ${item.table}:${item.recordId}`,
      );
      continue;
    }
    if (
      item.table === "services" &&
      item.payload.status === "completed" &&
      servicesWithVisitorConflicts.has(item.recordId)
    ) {
      result.blockedConflicts += 1;
      const completionMessage =
        "A visitor conflict must be reviewed before this service can be completed.";
      if (!visibleErrors.has(completionMessage)) {
        visibleErrors.add(completionMessage);
        result.errors.push(completionMessage);
      }
      continue;
    }
    const processing = {
      ...item,
      status: "processing" as const,
      attempts: item.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    await database.put("syncQueue", processing);
    announceDataChanged();
    if (process.env.NODE_ENV === "development") {
      console.info("[sync] mutation attempt", {
        mutationId: item.id,
        entityType: item.table,
        operation: item.operation,
        attempt: processing.attempts,
        trigger: options.trigger ?? "automatic",
      });
    }
    try {
      const receipt = await withTimeout(
        target.upsert(
          item.table,
          item.payload,
          item.table === "service_attendance"
            ? "organization_id,service_id,person_id"
            : "id",
          {
            organizationId,
            recordId: item.recordId,
            expectedVersion: item.baseVersion,
            basePayload: item.basePayload,
            mutationToken: item.mutationToken ?? item.id,
            legacyMutation:
              !item.mutationToken &&
              typeof item.baseVersion !== "number",
          },
        ),
        options.timeoutMs ?? 30_000,
      );
      const current = await database.get("syncQueue", item.id);
      if (
        current?.status === "processing" &&
        current.updatedAt === processing.updatedAt
      ) {
        if (receipt && item.table === "service_attendance") {
          const localAttendance = await database.get(
            "attendance",
            item.recordId,
          );
          if (localAttendance) {
            await database.put("attendance", {
              ...localAttendance,
              version: receipt.version,
              updatedAt: receipt.updatedAt ?? localAttendance.updatedAt,
            });
          }
        }
        await database.delete("syncQueue", item.id);
      } else if (current && receipt) {
        await database.put("syncQueue", {
          ...current,
          baseVersion: receipt.version,
          basePayload: {
            ...item.payload,
            version: receipt.version,
            ...(receipt.updatedAt
              ? { updated_at: receipt.updatedAt }
              : {}),
          },
          payload: {
            ...current.payload,
            version: receipt.version,
            ...(receipt.updatedAt
              ? { updated_at: receipt.updatedAt }
              : {}),
          },
        });
      }
      announceDataChanged();
      result.uploaded += 1;
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Upload synchronization failed.";
      const code =
        caught instanceof SupabaseUploadError ||
        caught instanceof SynchronizationConflictError
          ? caught.code
          : undefined;
      const diagnostic = code ? `${code}: ${message}` : message;
      result.diagnostics?.push(diagnostic);
      const current = await database.get("syncQueue", item.id);
      const mutationIsStillCurrent =
        current?.status === "processing" &&
        current.updatedAt === processing.updatedAt;
      if (mutationIsStillCurrent) {
        await database.put("syncQueue", {
          ...processing,
          status:
            caught instanceof VisitorSynchronizationConflictError ||
            caught instanceof AttendanceSynchronizationConflictError
              ? "conflict"
              : "error",
          lastError: diagnostic,
          conflict:
            caught instanceof VisitorSynchronizationConflictError
              ? caught.conflict
              : undefined,
          updatedAt: new Date().toISOString(),
        });
        announceDataChanged();
      }
      if (
        mutationIsStillCurrent &&
        (caught instanceof AttendanceSynchronizationConflictError ||
          caught instanceof VisitorSynchronizationConflictError)
      ) {
        result.blockedConflicts += 1;
      }
      if (
        mutationIsStillCurrent &&
        caught instanceof VisitorSynchronizationConflictError
      ) {
        servicesWithVisitorConflicts.add(caught.conflict.serviceId);
      }
      if (process.env.NODE_ENV === "development") {
        console.error("[sync] mutation failed", {
          mutationId: item.id,
          entityType: item.table,
          operation: item.operation,
          attempt: processing.attempts,
          trigger: options.trigger ?? "automatic",
          code,
          message,
        });
      }
      let recordName: string | undefined;
      if (item.table === "people") {
        recordName = (await database.get("people", item.recordId))?.displayName;
      } else if (item.table === "service_visitors") {
        recordName = (await database.get("visitors", item.recordId))?.displayName;
      } else if (item.table === "services") {
        const service = await database.get("services", item.recordId);
        recordName = service?.customName || service?.serviceType;
      } else if (item.table === "service_attendance") {
        const attendance = await database.get("attendance", item.recordId);
        if (attendance) {
          recordName = (
            await database.get("people", attendance.personId)
          )?.displayName;
        }
      }
      const visible = humanReadableSyncError({
        item,
        message,
        code,
        recordName,
      });
      if (!visibleErrors.has(visible)) {
        visibleErrors.add(visible);
        result.errors.push(visible);
      }
    }
  }

  return result;
}
