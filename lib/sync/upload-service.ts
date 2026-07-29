"use client";

import type { SyncQueueItem } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { getSupabaseClient } from "@/lib/supabase/client";

export interface UploadTarget {
  upsert(
    table: SyncQueueItem["table"],
    payload: Record<string, unknown>,
    onConflict: string,
  ): Promise<void>;
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
  | "scheduled";

interface UploadExecutionOptions {
  trigger?: SyncTrigger;
  timeoutMs?: number;
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
    async upsert(table, payload, onConflict) {
      const { error } = await getSupabaseClient()
        .from(table)
        .upsert(payload, { onConflict });
      if (error) throw new SupabaseUploadError(error.message, error.code);
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
      await withTimeout(
        target.upsert(
          item.table,
          item.payload,
          item.table === "service_attendance"
            ? "organization_id,service_id,person_id"
            : "id",
        ),
        options.timeoutMs ?? 30_000,
      );
      const current = await database.get("syncQueue", item.id);
      if (
        current?.status === "processing" &&
        current.updatedAt === processing.updatedAt
      ) {
        await database.delete("syncQueue", item.id);
      }
      result.uploaded += 1;
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Upload synchronization failed.";
      await database.put("syncQueue", {
        ...processing,
        status: "error",
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      if (process.env.NODE_ENV === "development") {
        console.error("[sync] mutation failed", {
          mutationId: item.id,
          entityType: item.table,
          operation: item.operation,
          attempt: processing.attempts,
          trigger: options.trigger ?? "automatic",
          code:
            caught instanceof SupabaseUploadError ? caught.code : undefined,
          message,
        });
      }
      result.errors.push(`${item.table}:${item.recordId}: ${message}`);
    }
  }

  return result;
}
