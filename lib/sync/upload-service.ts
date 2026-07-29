"use client";

import type { SyncQueueItem } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { getSupabaseClient } from "@/lib/supabase/client";

export interface UploadTarget {
  upsert(
    table: SyncQueueItem["table"],
    payload: Record<string, unknown>,
    onConflict: string,
    context?: {
      organizationId: string;
      recordId: string;
      expectedVersion?: number;
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

const UPLOAD_ORDER: SyncQueueItem["table"][] = [
  "organizations",
  "organization_settings",
  "people",
  "services",
  "service_attendance",
  "service_visitors",
];

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
      const client = getSupabaseClient() as unknown as {
        from(name: string): DynamicSupabaseTable;
      };
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
          .select("version,updated_at,created_at,last_mutation_id"),
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
        UPLOAD_ORDER.indexOf(a.table) - UPLOAD_ORDER.indexOf(b.table) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const result: UploadResult = { uploaded: 0, errors: [] };

  for (const item of queue) {
    const processing = {
      ...item,
      status: "processing" as const,
      attempts: item.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    await database.put("syncQueue", processing);
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
        await database.delete("syncQueue", item.id);
      } else if (current && receipt) {
        await database.put("syncQueue", {
          ...current,
          baseVersion: receipt.version,
          payload: {
            ...current.payload,
            version: receipt.version,
            ...(receipt.updatedAt
              ? { updated_at: receipt.updatedAt }
              : {}),
          },
        });
      }
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
      await database.put("syncQueue", {
        ...processing,
        status: "error",
        lastError: diagnostic,
        updatedAt: new Date().toISOString(),
      });
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
      result.errors.push(`${item.table}:${item.recordId}: ${diagnostic}`);
    }
  }

  return result;
}
