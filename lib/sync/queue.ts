"use client";

import { createId, nowIso, type SyncQueueItem } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";

export async function enqueueChange(
  input: Pick<
    SyncQueueItem,
    "organizationId" | "table" | "recordId" | "payload"
  >,
) {
  const database = await getDatabase();
  const existing = (
    await database.getAllFromIndex("syncQueue", "recordId", input.recordId)
  ).find((item) => item.table === input.table && item.status !== "processing");
  const timestamp = nowIso();
  const item: SyncQueueItem = existing
    ? {
        ...existing,
        payload: input.payload,
        status: "pending",
        lastError: undefined,
        updatedAt: timestamp,
      }
    : {
        id: createId(),
        ...input,
        operation: "upsert",
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  await database.put("syncQueue", item);
  return item;
}

export async function getPendingChanges(organizationId?: string) {
  const database = await getDatabase();
  const all = await database.getAll("syncQueue");
  return all.filter(
    (item) =>
      (!organizationId || item.organizationId === organizationId) &&
      item.status !== "processing",
  );
}

export async function getQueueCount(organizationId?: string) {
  return (await getPendingChanges(organizationId)).length;
}
