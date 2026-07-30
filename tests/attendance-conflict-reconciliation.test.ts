import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  getServiceAttendance,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { reconcileAttendanceMutation } from "@/lib/sync/attendance-conflicts";
import {
  getPendingChanges,
  recoverRetryableMutations,
} from "@/lib/sync/queue";
import {
  AttendanceSynchronizationConflictError,
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";

const organizationId = "20000000-0000-4000-8000-000000000150";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000150",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

async function queuedAttendanceEdit() {
  const member = await saveMember(admin, {
    firstName: "Avery",
    lastName: "Stone",
  });
  const service = await saveService(admin, {
    serviceDate: "2026-08-16",
    serviceType: "Sunday Morning",
    status: "draft",
  });
  const original = await setMemberAttendance(
    admin,
    service.id,
    member.id,
    false,
  );
  const database = await getDatabase();
  await database.clear("syncQueue");
  await database.put("attendance", { ...original, version: 7 });
  const local = await setMemberAttendance(
    admin,
    service.id,
    member.id,
    true,
  );
  return { member, service, local };
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("attendance semantic reconciliation", () => {
  it("treats identical attendance and version-only differences as satisfied", () => {
    expect(
      reconcileAttendanceMutation(
        { present: true, version: 3, updated_at: "local" },
        { present: false, version: 2 },
        { present: true, version: 99, updated_at: "server" },
      ),
    ).toEqual({ kind: "satisfied" });
  });

  it("rebases a deliberate local edit when only server metadata changed", () => {
    expect(
      reconcileAttendanceMutation(
        { present: true, version: 7 },
        { present: false, version: 7 },
        { present: false, version: 8 },
      ),
    ).toEqual({ kind: "apply-local" });
  });

  it("adopts a remote edit when the queued local semantic value never changed", () => {
    expect(
      reconcileAttendanceMutation(
        { present: false, version: 7 },
        { present: false, version: 7 },
        { present: true, version: 8 },
      ),
    ).toEqual({ kind: "satisfied" });
  });

  it("requires review when different states have no trustworthy base snapshot", () => {
    expect(
      reconcileAttendanceMutation(
        { present: true, version: 7 },
        undefined,
        { present: false, version: 8 },
      ),
    ).toEqual({ kind: "conflict" });
  });
});

describe("attendance conflict queue recovery", () => {
  it("stores the synchronized attendance base value with every later edit", async () => {
    await queuedAttendanceEdit();
    const queued = (await getPendingChanges(organizationId))[0];
    expect(queued).toMatchObject({
      table: "service_attendance",
      baseVersion: 7,
      basePayload: { present: false, version: 7 },
      payload: { present: true, version: 7 },
    });
  });

  it("clears an identical or already-applied mutation and adopts the receipt version", async () => {
    const { service } = await queuedAttendanceEdit();
    const target: UploadTarget = {
      async upsert() {
        return {
          version: 12,
          updatedAt: "2026-08-16T15:00:00.000Z",
        };
      },
    };

    const result = await uploadPendingChanges(organizationId, target);

    expect(result).toMatchObject({
      uploaded: 2,
      errors: [],
      blockedConflicts: 0,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect((await getServiceAttendance(service.id))[0]).toMatchObject({
      present: true,
      version: 12,
      updatedAt: "2026-08-16T15:00:00.000Z",
    });
  });

  it("recovers a stale attempt-238 mutation without clearing IndexedDB", async () => {
    const { service, local } = await queuedAttendanceEdit();
    const database = await getDatabase();
    const queued = (await getPendingChanges(organizationId))[0];
    await database.put("syncQueue", {
      ...queued,
      status: "error",
      attempts: 238,
      lastError:
        "SYNC_CONFLICT: changed on another device. The local change remains safely queued.",
    });
    await closeLocalDatabaseConnection();

    expect(await recoverRetryableMutations(organizationId)).toBe(1);
    const target: UploadTarget = {
      async upsert(_table, payload) {
        expect(payload.present).toBe(local.present);
        return { version: 13 };
      },
    };
    await uploadPendingChanges(organizationId, target);

    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect((await getServiceAttendance(service.id))[0]).toMatchObject({
      id: local.id,
      present: true,
      version: 13,
    });
  });

  it("marks a genuine different-state conflict once and never retries it automatically", async () => {
    const { local } = await queuedAttendanceEdit();
    let calls = 0;
    const target: UploadTarget = {
      async upsert(table) {
        if (table === "audit_log") return { version: 1 };
        calls += 1;
        throw new AttendanceSynchronizationConflictError(local.id);
      },
    };

    const first = await uploadPendingChanges(organizationId, target);
    const conflicted = (await getPendingChanges(organizationId))[0];
    expect(first.blockedConflicts).toBe(1);
    expect(conflicted).toMatchObject({
      id: expect.any(String),
      recordId: local.id,
      status: "conflict",
      attempts: 1,
    });
    expect(await recoverRetryableMutations(organizationId)).toBe(0);

    const second = await uploadPendingChanges(organizationId, target);
    expect(second.blockedConflicts).toBe(1);
    expect(calls).toBe(1);
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      id: conflicted.id,
      status: "conflict",
      attempts: 1,
    });
  });

  it("rebases a newer checkbox change created while an earlier upload is in flight", async () => {
    const { service, member } = await queuedAttendanceEdit();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const target: UploadTarget = {
      async upsert() {
        started();
        await gate;
        return {
          version: 8,
          updatedAt: "2026-08-16T15:00:00.000Z",
        };
      },
    };

    const upload = uploadPendingChanges(organizationId, target);
    await uploadStarted;
    await setMemberAttendance(admin, service.id, member.id, false);
    release();
    await upload;

    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      status: "pending",
      baseVersion: 8,
      basePayload: { present: true, version: 8 },
      payload: { present: false, version: 8 },
    });
  });

  it("fetches present before deciding whether a server version is a conflict", () => {
    const source = readFileSync(
      resolve("lib/sync/upload-service.ts"),
      "utf8",
    );
    expect(source).toContain(
      '"version,updated_at,created_at,last_mutation_id,present"',
    );
    expect(source).toContain("reconcileAttendanceMutation");
    expect(source).toContain(
      "AttendanceSynchronizationConflictError",
    );
  });
});
