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

const UPLOAD_ORDER: SyncQueueItem["table"][] = [
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
      if (error) throw new Error(error.message);
    },
  };
}

export async function uploadPendingChanges(
  organizationId: string,
  target: UploadTarget = createSupabaseUploadTarget(),
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
    try {
      await target.upsert(
        item.table,
        item.payload,
        item.table === "service_attendance"
          ? "organization_id,service_id,person_id"
          : "id",
      );
      await database.delete("syncQueue", item.id);
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
      result.errors.push(`${item.table}:${item.recordId}: ${message}`);
    }
  }

  return result;
}
