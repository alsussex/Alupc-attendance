"use client";

import {
  createId,
  nowIso,
  type AuditEntityType,
  type AuditLogEntry,
  type UserContext,
} from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { enqueueChange } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";

export interface AuditFilters {
  entityType?: AuditEntityType;
  entityId?: string;
  relatedEntityId?: string;
  relatedEntityIds?: string[];
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  query?: string;
  before?: string;
  limit?: number;
}

function deviceIdentifier() {
  const key = "church-attendance-device-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = createId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return undefined;
  }
}

async function actorDisplayName(user: UserContext) {
  const profile = await (await getDatabase()).get("profiles", user.userId);
  return profile?.displayName?.trim() || user.email || "Church user";
}

export async function recordAuditEntry(
  user: UserContext,
  input: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    details?: Record<string, unknown>;
  },
) {
  const timestamp = nowIso();
  const entry: AuditLogEntry = {
    id: createId(),
    organizationId: user.organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    userId: user.userId,
    userDisplayName: await actorDisplayName(user),
    role: user.role,
    occurredAt: timestamp,
    deviceId: deviceIdentifier(),
    details: input.details,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const database = await getDatabase();
  await database.put("auditLog", entry);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "audit_log",
    recordId: entry.id,
    payload: toCloudRecord(entry),
  });
  announceDataChanged();
  return entry;
}

function matches(entry: AuditLogEntry, filters: AuditFilters) {
  if (filters.entityType && entry.entityType !== filters.entityType) return false;
  if (filters.entityId && entry.entityId !== filters.entityId) return false;
  const relatedIds = [
    ...(filters.relatedEntityIds ?? []),
    ...(filters.relatedEntityId ? [filters.relatedEntityId] : []),
  ];
  if (
    relatedIds.length > 0 &&
    !relatedIds.some(
      (id) =>
        entry.entityId === id ||
        entry.details?.serviceId === id ||
        entry.details?.personId === id ||
        entry.details?.memberPersonId === id ||
        entry.details?.mergedSourceId === id ||
        entry.details?.targetId === id,
    )
  ) {
    return false;
  }
  if (filters.userId && entry.userId !== filters.userId) return false;
  if (filters.action && entry.action !== filters.action) return false;
  if (filters.from && entry.occurredAt < filters.from) return false;
  if (filters.to && entry.occurredAt > filters.to) return false;
  const query = filters.query?.trim().toLocaleLowerCase();
  if (
    query &&
    ![
      entry.userDisplayName,
      entry.action,
      entry.entityType,
      entry.entityId,
      JSON.stringify(entry.details ?? {}),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query)
  ) {
    return false;
  }
  return true;
}

export async function listAuditEntries(
  user: UserContext,
  filters: AuditFilters = {},
) {
  if (!isAdmin(user)) throw new Error("Administrator access is required.");
  const database = await getDatabase();
  const transaction = database.transaction("auditLog");
  const index = transaction.store.index("organizationOccurredAtId");
  const [beforeTime, beforeId] = filters.before?.split("|") ?? [];
  let cursor = await index.openCursor(
    IDBKeyRange.bound(
      [user.organizationId, "", ""],
      [user.organizationId, beforeTime || "\uffff", beforeId || "\uffff"],
      false,
      Boolean(beforeTime),
    ),
    "prev",
  );
  const results: AuditLogEntry[] = [];
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  while (cursor && results.length < limit) {
    const entry = cursor.value;
    if (
      matches(entry, filters)
    ) {
      results.push(entry);
    }
    cursor = await cursor.continue();
  }
  await transaction.done;
  return results;
}

export async function buildAuditExport(
  user: UserContext,
  format: "csv" | "json",
) {
  const rows: AuditLogEntry[] = [];
  let before: string | undefined;
  while (true) {
    const page = await listAuditEntries(user, { before, limit: 100 });
    rows.push(...page);
    if (page.length < 100) break;
    const last = page.at(-1);
    before = last ? `${last.occurredAt}|${last.id}` : undefined;
  }
  if (format === "json") return JSON.stringify(rows, null, 2);
  const cell = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [
    [
      "Timestamp UTC",
      "User",
      "Role",
      "Action",
      "Entity Type",
      "Entity ID",
      "Device ID",
      "Details",
    ].map(cell).join(","),
    ...rows.map((entry) =>
      [
        entry.occurredAt,
        entry.userDisplayName,
        entry.role,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.deviceId,
        JSON.stringify(entry.details ?? {}),
      ].map(cell).join(","),
    ),
  ].join("\r\n");
}
