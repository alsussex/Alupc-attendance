import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PullTable,
  SyncQueueItem,
  UserContext,
} from "@/lib/domain";
import {
  addServiceVisitor,
  editServiceVisitor,
  getServiceAttendance,
  listServiceVisitors,
  listServices,
  saveMember,
  saveService,
  setMemberAttendance,
  setUnnamedVisitorCount,
} from "@/lib/repositories/attendance-repository";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  synchronizeNow,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";
import {
  SynchronizationConflictError,
  type UploadReceipt,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";

const organizationId = "20000000-0000-4000-8000-000000000140";
const otherOrganizationId = "20000000-0000-4000-8000-000000000141";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000140",
  organizationId,
  email: "casey@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000141",
  organizationId,
  email: "riley@example.test",
  role: "attendance_taker",
};

class VersionedOrganizationCloud implements PullSource, UploadTarget {
  readonly rows = new Map<string, Record<string, unknown>>();
  private revision = 0;

  private key(table: string, payload: Record<string, unknown>) {
    return `${table}:${String(payload.id)}`;
  }

  async upsert(
    table: SyncQueueItem["table"],
    payload: Record<string, unknown>,
    _onConflict: string,
    context?: {
      organizationId: string;
      recordId: string;
      expectedVersion?: number;
      mutationToken: string;
    },
  ): Promise<UploadReceipt> {
    const key = this.key(table, payload);
    const current = this.rows.get(key);
    if (
      current &&
      current.last_mutation_id === context?.mutationToken
    ) {
      return {
        version: Number(current.version),
        updatedAt: String(current.updated_at),
      };
    }
    if (
      current &&
      typeof context?.expectedVersion === "number" &&
      context.expectedVersion !== current.version
    ) {
      throw new SynchronizationConflictError(
        `${table}:${context.recordId} changed on another device.`,
      );
    }
    if (current && typeof context?.expectedVersion !== "number") {
      throw new SynchronizationConflictError(
        `${table}:${context?.recordId} has no trusted base version.`,
      );
    }
    this.revision += 1;
    const updatedAt = new Date(
      Date.UTC(2026, 6, 29, 18, 0, this.revision),
    ).toISOString();
    const next = {
      ...payload,
      version: current ? Number(current.version) + 1 : 1,
      updated_at: updatedAt,
      last_mutation_id: context?.mutationToken,
    };
    this.rows.set(key, next);
    return { version: Number(next.version), updatedAt };
  }

  async fetchPage(
    table: PullTable,
    requestedOrganizationId: string,
    updatedAt: string | undefined,
    offset: number,
    limit: number,
  ) {
    const rows = [...this.rows.entries()]
      .filter(([key, row]) => {
        if (!key.startsWith(`${table}:`)) return false;
        const matchesOrganization =
          table === "organizations"
            ? row.id === requestedOrganizationId
            : row.organization_id === requestedOrganizationId;
        return (
          matchesOrganization &&
          (!updatedAt ||
            String(row.updated_at).localeCompare(updatedAt) >= 0)
        );
      })
      .map(([, row]) => row)
      .sort(
        (left, right) =>
          String(left.updated_at).localeCompare(String(right.updated_at)) ||
          String(left.id).localeCompare(String(right.id)),
      )
      .slice(offset, offset + limit);
    return { rows, hasMore: rows.length === limit };
  }
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("cross-device organization drafts", () => {
  it("converges service, attendance, named visitors, and unnamed visitors across two accounts", async () => {
    const cloud = new VersionedOrganizationCloud();

    const member = await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const draft = await saveService(admin, {
      serviceDate: "2026-07-29",
      serviceType: "Wednesday Bible Study",
      serviceTime: "19:00",
      status: "draft",
    });
    const attendance = await setMemberAttendance(
      admin,
      draft.id,
      member.id,
      true,
    );
    const { visitor } = await addServiceVisitor(admin, draft.id, {
      firstName: "Jordan",
      lastName: "West",
      notes: "First visit",
      saveAsMember: false,
    });
    await setUnnamedVisitorCount(admin, draft.id, 2);
    await synchronizeOrganization(admin, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    await clearLocalDatabase();
    await synchronizeOrganization(attendanceTaker, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    const deviceBDraft = (await listServices(organizationId))[0];
    expect(deviceBDraft).toMatchObject({
      id: draft.id,
      status: "draft",
      unnamedVisitorCount: 2,
    });
    expect((await getServiceAttendance(draft.id))[0]).toMatchObject({
      id: attendance.id,
      personId: member.id,
      present: true,
    });
    expect((await listServiceVisitors(draft.id))[0]).toMatchObject({
      id: visitor.id,
      notes: "First visit",
    });

    await setMemberAttendance(
      attendanceTaker,
      draft.id,
      member.id,
      false,
    );
    await editServiceVisitor(attendanceTaker, visitor.id, {
      firstName: "Jordan",
      lastName: "West",
      notes: "Returning next week",
    });
    await setUnnamedVisitorCount(attendanceTaker, draft.id, 3);
    await synchronizeOrganization(attendanceTaker, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    await clearLocalDatabase();
    await pullOrganizationData(admin, cloud);
    expect((await listServices(organizationId))[0]).toMatchObject({
      id: draft.id,
      unnamedVisitorCount: 3,
    });
    expect((await getServiceAttendance(draft.id))[0]).toMatchObject({
      id: attendance.id,
      present: false,
    });
    expect((await listServiceVisitors(draft.id))[0]).toMatchObject({
      id: visitor.id,
      notes: "Returning next week",
    });
  });

  it("makes Sync now download a draft missing from the current device", async () => {
    const cloud = new VersionedOrganizationCloud();
    const draft = await saveService(admin, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await synchronizeOrganization(admin, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    await clearLocalDatabase();
    await synchronizeNow(attendanceTaker, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });
    expect(await listServices(organizationId)).toEqual([
      expect.objectContaining({ id: draft.id, status: "draft" }),
    ]);
  });

  it("preserves offline mutations and stable IDs until reconnection", async () => {
    const cloud = new VersionedOrganizationCloud();
    const member = await saveMember(attendanceTaker, {
      firstName: "Morgan",
      lastName: "River",
    });
    const draft = await saveService(attendanceTaker, {
      serviceDate: "2026-08-05",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    const attendance = await setMemberAttendance(
      attendanceTaker,
      draft.id,
      member.id,
      true,
    );
    const queuedBeforeRestart = await getPendingChanges(organizationId);
    expect(queuedBeforeRestart).toHaveLength(3);

    await synchronizeOrganization(attendanceTaker, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);

    await clearLocalDatabase();
    await pullOrganizationData(admin, cloud);
    expect((await listServices(organizationId))[0].id).toBe(draft.id);
    expect((await getServiceAttendance(draft.id))[0]).toMatchObject({
      id: attendance.id,
      personId: member.id,
    });
  });

  it("lets completion win over a stale queued draft without losing attendance", async () => {
    const cloud = new VersionedOrganizationCloud();
    const member = await saveMember(admin, {
      firstName: "Taylor",
      lastName: "Lane",
    });
    const draft = await saveService(admin, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    await setMemberAttendance(admin, draft.id, member.id, true);
    await synchronizeOrganization(admin, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    const staleDraft = (await listServices(organizationId))[0];
    await saveService(admin, { ...staleDraft, status: "draft" });
    const staleQueue = await getPendingChanges(organizationId);

    await clearLocalDatabase();
    await pullOrganizationData(attendanceTaker, cloud);
    const current = (await listServices(organizationId))[0];
    await saveService(attendanceTaker, { ...current, status: "completed" });
    await synchronizeOrganization(attendanceTaker, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    await clearLocalDatabase();
    const database = await getDatabase();
    await database.put("services", staleDraft);
    for (const mutation of staleQueue) {
      await database.put("syncQueue", mutation);
    }
    await synchronizeNow(admin, {
      pullSource: cloud,
      uploadTarget: cloud,
      isOnline: true,
    });

    expect((await listServices(organizationId))[0]).toMatchObject({
      id: draft.id,
      status: "completed",
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    await pullOrganizationData(admin, cloud, { fullSnapshot: true });
    expect((await getServiceAttendance(draft.id))[0]).toMatchObject({
      personId: member.id,
      present: true,
    });
  });

  it("never downloads another organization's draft", async () => {
    const cloud = new VersionedOrganizationCloud();
    cloud.rows.set("services:outside", {
      id: "outside",
      organization_id: otherOrganizationId,
      service_date: "2026-08-12",
      service_type: "Special Service",
      status: "draft",
      is_archived: false,
      unnamed_visitor_count: 0,
      version: 1,
      created_by: "10000000-0000-4000-8000-000000000199",
      updated_by: "10000000-0000-4000-8000-000000000199",
      created_at: "2026-07-29T18:00:00.000Z",
      updated_at: "2026-07-29T18:00:00.000Z",
    });
    await pullOrganizationData(admin, cloud);
    expect(await listServices(organizationId)).toEqual([]);
  });
});

describe("draft discovery triggers and duplicate protection", () => {
  it("uses realtime plus startup, focus, reconnect, manual sync, and a 30-second fallback", () => {
    const provider = readFileSync(
      resolve("components/sync/SyncProvider.tsx"),
      "utf8",
    );
    const service = readFileSync(
      resolve("lib/sync/sync-service.ts"),
      "utf8",
    );
    const realtime = readFileSync(
      resolve("lib/sync/remote-change-listener.ts"),
      "utf8",
    );
    expect(provider).toContain('"startup"');
    expect(provider).toContain('"online"');
    expect(provider).toContain('"remote"');
    expect(provider).toContain("synchronizeNow");
    expect(service).toContain('window.addEventListener("focus"');
    expect(service).toContain("30_000");
    expect(realtime).toContain('"services"');
    expect(realtime).toContain('"service_attendance"');
    expect(realtime).toContain('"service_visitors"');
  });

  it("documents stable primary keys and database duplicate guards", () => {
    const stageOne = readFileSync(
      resolve("supabase/migrations/202607290001_stage_one.sql"),
      "utf8",
    );
    const repository = readFileSync(
      resolve("lib/repositories/attendance-repository.ts"),
      "utf8",
    );
    expect(stageOne).toMatch(
      /unique \(organization_id, service_id, person_id\)/,
    );
    expect(stageOne).toMatch(
      /foreign key \(organization_id, service_id\)\s+references public\.services\(organization_id, id\)/,
    );
    expect(repository).toContain("id: input.id ?? createId()");
    expect(repository).toContain("const id = attendanceId(serviceId, personId)");
  });
});
