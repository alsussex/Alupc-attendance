"use client";

import {
  createId,
  makeDisplayName,
  nowIso,
  type SyncQueueItem,
  type ServiceVisitor,
  type VisitorConflictField,
  type VisitorSyncConflict,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged, announceMutationQueued } from "@/lib/storage/data-events";
import { fromCloudRecord } from "@/lib/sync/serialization";

const VISITOR_FIELDS = [
  "service_id",
  "visitor_person_id",
  "first_name",
  "last_name",
  "display_name",
  "saved_as_member",
  "member_person_id",
  "notes",
  "deleted_at",
] as const;

type VisitorField = (typeof VISITOR_FIELDS)[number];

export type VisitorReconciliation =
  | { kind: "satisfied"; serverRecord: Record<string, unknown> }
  | { kind: "merged"; payload: Record<string, unknown> }
  | { kind: "conflict"; conflict: VisitorSyncConflict };

function meaningfulValue(field: VisitorField, value: unknown) {
  if (field === "deleted_at") return Boolean(value);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : value;
}

function sameField(
  field: VisitorField,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return (
    meaningfulValue(field, left[field]) === meaningfulValue(field, right[field])
  );
}

export function visitorContentsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return VISITOR_FIELDS.every((field) => sameField(field, left, right));
}

export function reconcileVisitorMutation(
  local: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  server: Record<string, unknown>,
): VisitorReconciliation {
  if (visitorContentsEqual(local, server)) {
    return { kind: "satisfied", serverRecord: server };
  }

  // A tombstone always wins over an older active copy. A local removal is
  // safely rebased onto the newest remote fields; a remote removal is already
  // satisfied and must never be undone by a stale device.
  if (server.deleted_at && !local.deleted_at) {
    return { kind: "satisfied", serverRecord: server };
  }

  if (!base) {
    return {
      kind: "conflict",
      conflict: makeConflict(local, server, VISITOR_FIELDS.filter(
        (field) => !sameField(field, local, server),
      )),
    };
  }

  const localChanges = VISITOR_FIELDS.filter(
    (field) => !sameField(field, local, base),
  );
  const remoteChanges = new Set(
    VISITOR_FIELDS.filter((field) => !sameField(field, server, base)),
  );
  const conflicting = localChanges.filter(
    (field) => remoteChanges.has(field) && !sameField(field, local, server),
  );
  if (conflicting.length > 0) {
    return {
      kind: "conflict",
      conflict: makeConflict(local, server, conflicting),
    };
  }

  const payload = { ...server };
  for (const field of localChanges) payload[field] = local[field];
  if (visitorContentsEqual(payload, server)) {
    return { kind: "satisfied", serverRecord: server };
  }
  return { kind: "merged", payload };
}

function makeConflict(
  local: Record<string, unknown>,
  server: Record<string, unknown>,
  fields: VisitorField[],
): VisitorSyncConflict {
  const conflicts: VisitorConflictField[] = fields.map((field) => ({
    field,
    localValue: local[field],
    serverValue: server[field],
  }));
  return {
    kind: "visitor",
    visitorId: String(local.id),
    serviceId: String(local.service_id),
    organizationId: String(local.organization_id),
    visitorName:
      String(local.display_name || server.display_name || "Visitor"),
    localVersion:
      typeof local.version === "number" ? local.version : undefined,
    serverVersion:
      typeof server.version === "number" ? server.version : undefined,
    localUpdatedAt:
      typeof local.updated_at === "string" ? local.updated_at : undefined,
    serverUpdatedAt:
      typeof server.updated_at === "string" ? server.updated_at : undefined,
    localUpdatedBy:
      typeof local.updated_by === "string" ? local.updated_by : undefined,
    serverUpdatedBy:
      typeof server.updated_by === "string" ? server.updated_by : undefined,
    fields: conflicts,
    serverRecord: server,
  };
}

export async function listVisitorConflicts(
  organizationId: string,
  serviceId?: string,
) {
  const database = await getDatabase();
  return (
    await database.getAllFromIndex("syncQueue", "organizationId", organizationId)
  ).filter(
    (item) =>
      item.table === "service_visitors" &&
      item.status === "conflict" &&
      item.conflict?.kind === "visitor" &&
      (!serviceId || item.conflict.serviceId === serviceId),
  );
}

export async function resolveVisitorConflict(
  organizationId: string,
  mutationId: string,
  strategy: "local" | "server" | "manual",
  manual?: { firstName: string; lastName: string; notes?: string },
) {
  const database = await getDatabase();
  const item = await database.get("syncQueue", mutationId);
  if (
    !item ||
    item.organizationId !== organizationId ||
    item.table !== "service_visitors" ||
    !item.conflict
  ) {
    throw new Error("Visitor conflict not found.");
  }
  const server = item.conflict.serverRecord;
  if (strategy === "server") {
    await database.put(
      "visitors",
      fromCloudRecord("service_visitors", server) as ServiceVisitor,
    );
    await database.delete("syncQueue", item.id);
    announceDataChanged();
    return;
  }

  let payload: Record<string, unknown> = {
    ...item.payload,
    version: server.version,
    updated_at: item.payload.updated_at ?? nowIso(),
    // Neither Keep Local nor a manual name/notes merge may resurrect a
    // visitor removed by another authorized device.
    deleted_at: server.deleted_at || item.payload.deleted_at || null,
  };
  if (strategy === "manual" && manual) {
    const firstName = manual.firstName.trim();
    const lastName = manual.lastName.trim();
    payload = {
      ...payload,
      first_name: firstName,
      last_name: lastName,
      display_name: makeDisplayName(firstName, lastName),
      notes: manual.notes?.trim() || null,
    };
    await database.put(
      "visitors",
      fromCloudRecord("service_visitors", {
        ...server,
        ...payload,
      }) as ServiceVisitor,
    );
  }
  const pending: SyncQueueItem = {
    ...item,
    payload,
    basePayload: server,
    baseVersion:
      typeof server.version === "number" ? server.version : item.baseVersion,
    mutationToken: createId(),
    status: "pending",
    conflict: undefined,
    lastError: undefined,
    updatedAt: nowIso(),
  };
  await database.put("syncQueue", pending);
  announceMutationQueued();
  announceDataChanged();
}
