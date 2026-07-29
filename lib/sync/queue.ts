"use client";

import { createId, nowIso, type SyncQueueItem } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceMutationQueued } from "@/lib/storage/data-events";

export const STALE_PROCESSING_TIMEOUT_MS = 2 * 60 * 1_000;

export async function enqueueChange(
  input: Pick<
    SyncQueueItem,
    "organizationId" | "table" | "recordId" | "payload"
  >,
) {
  const database = await getDatabase();
  const existing = (
    await database.getAllFromIndex("syncQueue", "recordId", input.recordId)
  ).find((item) => item.table === input.table);
  const timestamp = nowIso();
  const payloadVersion =
    typeof input.payload.version === "number"
      ? input.payload.version
      : undefined;
  const item: SyncQueueItem = existing
    ? {
        ...existing,
        payload: input.payload,
        baseVersion: existing.baseVersion ?? payloadVersion,
        mutationToken: createId(),
        status: "pending",
        lastError: undefined,
        updatedAt: timestamp,
      }
    : {
        id: createId(),
        ...input,
        operation: "upsert",
        baseVersion: payloadVersion,
        mutationToken: createId(),
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  await database.put("syncQueue", item);
  announceMutationQueued();
  return item;
}

export async function getPendingChanges(organizationId?: string) {
  const database = await getDatabase();
  const all = await database.getAll("syncQueue");
  return all.filter(
    (item) =>
      !organizationId || item.organizationId === organizationId,
  );
}

export async function getQueueCount(organizationId?: string) {
  return (await getPendingChanges(organizationId)).length;
}

export async function recoverRetryableMutations(
  organizationId: string,
  options: { forceProcessing?: boolean; now?: number } = {},
) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "syncQueue",
    "organizationId",
    organizationId,
  );
  const now = options.now ?? Date.now();
  let recovered = 0;

  for (const record of records) {
    const processingIsStale =
      record.status === "processing" &&
      (options.forceProcessing === true ||
        now - Date.parse(record.updatedAt) >= STALE_PROCESSING_TIMEOUT_MS);
    if (record.status !== "error" && !processingIsStale) continue;
    await database.put("syncQueue", {
      ...record,
      status: "pending",
      lastError: undefined,
      updatedAt: nowIso(),
    });
    recovered += 1;
  }
  return recovered;
}
