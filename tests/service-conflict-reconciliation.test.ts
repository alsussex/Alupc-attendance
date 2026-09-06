import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import { saveService } from "@/lib/repositories/attendance-repository";
import { syncDiagnosticDetails } from "@/lib/sync/errors";
import {
  reconcileServiceMutation,
  serviceConflictFieldLabels,
} from "@/lib/sync/service-conflicts";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";

const organizationId = "20000000-0000-4000-8000-000000000990";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000990",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

const base = {
  service_date: "2026-09-06",
  service_type: "Sunday Morning",
  custom_name: null,
  service_time: "10:30",
  notes: null,
  status: "draft",
  unnamed_visitor_count: 0,
  sunday_school_kids_count: 0,
  is_archived: false,
  deleted_at: null,
  version: 4,
  updated_at: "2026-09-06T13:00:00.000Z",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("service semantic reconciliation", () => {
  it("clears identical content despite version-only differences", () => {
    expect(
      reconcileServiceMutation(
        { ...base, version: 4 },
        base,
        { ...base, version: 9, updated_at: "2026-09-06T14:00:00.000Z" },
      ).kind,
    ).toBe("satisfied");
  });

  it("preserves a newer completion over an unchanged stale draft", () => {
    const result = reconcileServiceMutation(
      base,
      base,
      { ...base, status: "completed", version: 5 },
    );
    expect(result).toMatchObject({
      kind: "satisfied",
      payload: { status: "completed" },
    });
  });

  it("rebases a deliberate reopen made from a completed base", () => {
    const completed = { ...base, status: "completed", version: 8 };
    const result = reconcileServiceMutation(
      { ...completed, status: "draft" },
      completed,
      { ...completed, version: 9 },
    );
    expect(result).toMatchObject({
      kind: "retry",
      payload: { status: "draft" },
    });
  });

  it("recovers a legacy reopen without overwriting newer server details", () => {
    const result = reconcileServiceMutation(
      {
        ...base,
        status: "draft",
        notes: "Stale local note",
        unnamed_visitor_count: 1,
        updated_by: admin.userId,
        updated_at: "2026-09-06T23:05:00.000Z",
      },
      undefined,
      {
        ...base,
        status: "completed",
        notes: "Current server note",
        unnamed_visitor_count: 4,
        service_time: "10:30:00",
        updated_at: "2026-09-06T23:00:00.000Z",
      },
    );
    expect(result).toMatchObject({
      kind: "retry",
      payload: {
        status: "draft",
        notes: "Current server note",
        unnamed_visitor_count: 4,
        updated_by: admin.userId,
      },
    });
  });

  it("merges non-overlapping edits and retains genuine same-field conflicts", () => {
    expect(
      reconcileServiceMutation(
        { ...base, notes: "Local note" },
        base,
        { ...base, custom_name: "Communion Sunday", version: 5 },
      ),
    ).toMatchObject({
      kind: "retry",
      payload: { notes: "Local note", custom_name: "Communion Sunday" },
    });
    const conflict = reconcileServiceMutation(
      { ...base, notes: "Local note" },
      base,
      { ...base, notes: "Remote note", version: 5 },
    );
    expect(conflict).toEqual({ kind: "conflict", fields: ["notes"] });
    if (conflict.kind === "conflict") {
      expect(serviceConflictFieldLabels(conflict.fields)).toEqual(["notes"]);
    }
  });
});

describe("service queue version recovery", () => {
  it("stores a base snapshot and adopts the upload receipt version locally", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await uploadPendingChanges(organizationId, {
      async upsert() {
        return { version: 7, updatedAt: "2026-09-06T14:00:00.000Z" };
      },
    });
    const uploaded = await (await getDatabase()).get("services", service.id);
    expect(uploaded).toMatchObject({ version: 7 });

    await saveService(admin, { ...uploaded!, notes: "Updated", status: "draft" });
    const queued = (await getPendingChanges(organizationId)).find(
      (item) => item.table === "services",
    );
    expect(queued).toMatchObject({
      baseVersion: 7,
      basePayload: { version: 7, notes: null },
      payload: { version: 7, notes: "Updated" },
    });
  });

  it("adopts an authoritative server service when a queued edit is satisfied", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const serverPayload = {
      ...base,
      id: service.id,
      organization_id: organizationId,
      created_at: service.createdAt,
      updated_at: "2026-09-06T15:00:00.000Z",
      created_by: admin.userId,
      updated_by: admin.userId,
      version: 11,
    };
    const target: UploadTarget = {
      async upsert() {
        return {
          version: 11,
          updatedAt: String(serverPayload.updated_at),
          serverPayload,
        };
      },
    };
    await uploadPendingChanges(organizationId, target);
    expect(await (await getDatabase()).get("services", service.id)).toMatchObject({
      version: 11,
      updatedAt: serverPayload.updated_at,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });
});

describe("sync diagnostic codes", () => {
  it("does not mistake the word newer for an error code", () => {
    expect(
      syncDiagnosticDetails(
        "Service has newer changes from another device.",
      )?.code,
    ).toBeUndefined();
    expect(
      syncDiagnosticDetails("SYNC_CONFLICT: Service changed")?.code,
    ).toBe("SYNC_CONFLICT");
  });
});
