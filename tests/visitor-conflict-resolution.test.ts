import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  SyncQueueItem,
  UserContext,
  VisitorSyncConflict,
} from "@/lib/domain";
import {
  addServiceVisitor,
  editServiceVisitor,
  listServiceVisitors,
  removeServiceVisitor,
  saveService,
} from "@/lib/repositories/attendance-repository";
import {
  getPendingChanges,
  recoverRetryableMutations,
} from "@/lib/sync/queue";
import {
  resolveVisitorConflict,
  reconcileVisitorMutation,
  visitorContentsEqual,
} from "@/lib/sync/visitor-conflicts";
import {
  VisitorSynchronizationConflictError,
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";

const organizationId = "20000000-0000-4000-8000-000000000130";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000130",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

const base = {
  id: "60000000-0000-4000-8000-000000000130",
  organization_id: organizationId,
  service_id: "40000000-0000-4000-8000-000000000130",
  first_name: "Sarah",
  last_name: "Johnson",
  display_name: "Sarah Johnson",
  saved_as_member: false,
  member_person_id: null,
  notes: "First visit",
  deleted_at: null,
  version: 3,
  last_mutation_id: null,
  created_by: admin.userId,
  updated_by: admin.userId,
  created_at: "2026-07-29T10:00:00.000Z",
  updated_at: "2026-07-29T10:00:00.000Z",
};

function conflict(
  local = { ...base, notes: "Local note" },
  server = { ...base, notes: "Server note", version: 4 },
): VisitorSyncConflict {
  const result = reconcileVisitorMutation(local, base, server);
  if (result.kind !== "conflict") throw new Error("Expected conflict");
  return result.conflict;
}

async function storeConflict(
  strategyConflict = conflict(),
  payload: Record<string, unknown> = { ...base, notes: "Local note" },
) {
  const database = await getDatabase();
  const visitor = {
    id: String(payload.id),
    organizationId,
    serviceId: String(payload.service_id),
    firstName: String(payload.first_name),
    lastName: String(payload.last_name),
    displayName: String(payload.display_name),
    savedAsMember: false,
    notes: String(payload.notes),
    version: 3,
    createdBy: admin.userId,
    updatedBy: admin.userId,
    createdAt: String(payload.created_at),
    updatedAt: String(payload.updated_at),
  };
  await database.put("visitors", visitor);
  const item: SyncQueueItem = {
    id: "70000000-0000-4000-8000-000000000130",
    organizationId,
    table: "service_visitors",
    operation: "upsert",
    recordId: visitor.id,
    payload,
    basePayload: base,
    baseVersion: 3,
    mutationToken: "80000000-0000-4000-8000-000000000130",
    status: "conflict",
    attempts: 1,
    lastError: "Visitor changes need review.",
    conflict: strategyConflict,
    createdAt: "2026-07-29T10:01:00.000Z",
    updatedAt: "2026-07-29T10:02:00.000Z",
  };
  await database.put("syncQueue", item);
  return item;
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("visitor semantic reconciliation", () => {
  it("treats identical content and version-only changes as already satisfied", () => {
    const server = {
      ...base,
      version: 9,
      updated_at: "2026-07-29T11:00:00.000Z",
      last_mutation_id: "90000000-0000-4000-8000-000000000130",
    };
    expect(visitorContentsEqual(base, server)).toBe(true);
    expect(reconcileVisitorMutation(base, undefined, server).kind).toBe(
      "satisfied",
    );
  });

  it("merges non-overlapping visitor edits while preserving notes", () => {
    const local = { ...base, notes: "Needs follow-up" };
    const server = {
      ...base,
      first_name: "Sara",
      display_name: "Sara Johnson",
      version: 4,
    };
    const result = reconcileVisitorMutation(local, base, server);
    expect(result).toMatchObject({
      kind: "merged",
      payload: {
        first_name: "Sara",
        display_name: "Sara Johnson",
        notes: "Needs follow-up",
      },
    });
  });

  it("retains genuine same-field conflicts for review", () => {
    const result = reconcileVisitorMutation(
      { ...base, notes: "Local note" },
      base,
      { ...base, notes: "Server note", version: 4 },
    );
    expect(result).toMatchObject({
      kind: "conflict",
      conflict: {
        visitorName: "Sarah Johnson",
        fields: [
          {
            field: "notes",
            localValue: "Local note",
            serverValue: "Server note",
          },
        ],
      },
    });
  });

  it("preserves remote and local visitor tombstones without resurrection", () => {
    expect(
      reconcileVisitorMutation(
        { ...base, notes: "Stale active copy" },
        base,
        { ...base, deleted_at: "2026-07-29T11:00:00.000Z", version: 4 },
      ).kind,
    ).toBe("satisfied");

    const localRemoval = reconcileVisitorMutation(
      { ...base, deleted_at: "2026-07-29T11:01:00.000Z" },
      base,
      { ...base, notes: "New server note", version: 4 },
    );
    expect(localRemoval).toMatchObject({
      kind: "merged",
      payload: {
        notes: "New server note",
        deleted_at: "2026-07-29T11:01:00.000Z",
      },
    });
  });
});

describe("visitor conflict queue and manual resolution", () => {
  it("stores a base snapshot when editing an already synchronized visitor", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Taylor",
      lastName: "Brooks",
      saveAsMember: false,
      notes: "Original",
    });
    const database = await getDatabase();
    await database.clear("syncQueue");
    await database.put("visitors", { ...visitor, version: 5 });
    await editServiceVisitor(admin, visitor.id, {
      firstName: "Taylor",
      lastName: "Brooks",
      notes: "Updated locally",
    });
    const queued = (await getPendingChanges(organizationId))[0];
    expect(queued.baseVersion).toBe(5);
    expect(queued.basePayload?.notes).toBe("Original");
    expect(queued.payload.notes).toBe("Updated locally");
  });

  it("marks genuine conflicts for Admin review and does not retry-loop them", async () => {
    const item = await storeConflict();
    const target: UploadTarget = {
      async upsert() {
        throw new VisitorSynchronizationConflictError(item.conflict!);
      },
    };
    await (await getDatabase()).put("syncQueue", {
      ...item,
      status: "pending",
      conflict: undefined,
    });
    const result = await uploadPendingChanges(organizationId, target);
    expect(result.errors[0]).toContain("Sarah Johnson has changes");
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      status: "conflict",
      conflict: { visitorName: "Sarah Johnson" },
    });
    expect(await recoverRetryableMutations(organizationId)).toBe(0);
  });

  it("Keep Server adopts the server visitor and removes the mutation", async () => {
    const item = await storeConflict();
    await resolveVisitorConflict(organizationId, item.id, "server");
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect((await listServiceVisitors(String(base.service_id)))[0]).toMatchObject({
      notes: "Server note",
      version: 4,
    });
  });

  it("Keep Local rebases onto the server version and retries safely", async () => {
    const item = await storeConflict();
    await resolveVisitorConflict(organizationId, item.id, "local");
    const queued = (await getPendingChanges(organizationId))[0];
    expect(queued).toMatchObject({
      status: "pending",
      baseVersion: 4,
      payload: { notes: "Local note", version: 4 },
      conflict: undefined,
    });
  });

  it("manual merge saves the chosen name and notes before retry", async () => {
    const item = await storeConflict();
    await resolveVisitorConflict(organizationId, item.id, "manual", {
      firstName: "Sara",
      lastName: "Johnston",
      notes: "Combined notes",
    });
    expect((await listServiceVisitors(String(base.service_id)))[0]).toMatchObject({
      displayName: "Sara Johnston",
      notes: "Combined notes",
    });
    expect((await getPendingChanges(organizationId))[0].payload).toMatchObject({
      display_name: "Sara Johnston",
      notes: "Combined notes",
    });
  });

  it("removal conflicts preserve the tombstone through browser restart", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-09-13",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "West",
      saveAsMember: false,
      notes: "Keep this note",
    });
    await (await getDatabase()).clear("syncQueue");
    await removeServiceVisitor(admin, visitor.id);
    await closeLocalDatabaseConnection();
    const queued = (await getPendingChanges(organizationId))[0];
    expect(queued.payload).toMatchObject({
      id: visitor.id,
      notes: "Keep this note",
    });
    expect(queued.payload.deleted_at).toBeTruthy();
  });

  it("idempotent retries retain one visitor UUID and clear an accepted mutation", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-09-20",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Riley",
      lastName: "Green",
      saveAsMember: false,
    });
    const rows = new Map<string, Record<string, unknown>>();
    const target: UploadTarget = {
      async upsert(table, payload) {
        rows.set(`${table}:${String(payload.id)}`, payload);
        return { version: 1 };
      },
    };
    await uploadPendingChanges(organizationId, target);
    await uploadPendingChanges(organizationId, target);
    const businessRows = [...rows.keys()].filter(
      (key) => !key.startsWith("audit_log:"),
    );
    expect(businessRows).toHaveLength(2); // one service and one visitor
    expect(rows.has(`service_visitors:${visitor.id}`)).toBe(true);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("blocks a queued completion until a genuine visitor conflict is resolved", async () => {
    const visitorConflict = await storeConflict();
    const database = await getDatabase();
    const completion: SyncQueueItem = {
      id: "71000000-0000-4000-8000-000000000130",
      organizationId,
      table: "services",
      operation: "upsert",
      recordId: String(base.service_id),
      payload: {
        id: base.service_id,
        organization_id: organizationId,
        status: "completed",
      },
      baseVersion: 3,
      mutationToken: "81000000-0000-4000-8000-000000000130",
      status: "pending",
      attempts: 0,
      createdAt: "2026-07-29T10:03:00.000Z",
      updatedAt: "2026-07-29T10:03:00.000Z",
    };
    await database.put("syncQueue", completion);
    const uploaded: string[] = [];
    const target: UploadTarget = {
      async upsert(table) {
        uploaded.push(table);
        return { version: 4 };
      },
    };

    const blocked = await uploadPendingChanges(organizationId, target);
    expect(blocked.errors.join(" ")).toContain(
      "visitor conflict must be reviewed",
    );
    expect(uploaded).not.toContain("services");

    await resolveVisitorConflict(
      organizationId,
      visitorConflict.id,
      "server",
    );
    await uploadPendingChanges(organizationId, target);
    expect(uploaded).toContain("services");
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });
});

describe("service completion conflict experience", () => {
  it("preflights synchronization before completing and presents role-safe UI", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const completion = source.slice(
      source.indexOf('if (status === "completed" && navigator.onLine)'),
      source.indexOf("const updated = await saveService"),
    );
    expect(completion).toContain("await syncNow()");
    expect(completion).toContain("listVisitorConflicts");
    expect(source).toContain("Review Conflict");
    expect(source).toContain(
      "An administrator needs to review them before this service can be finished.",
    );
    expect(source).not.toContain("SYNC_CONFLICT");
  });
});
