import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  ChurchService,
  PullTable,
  UserContext,
} from "@/lib/domain";
import {
  addServiceVisitor,
  getServiceAttendance,
  listServices,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import {
  filterServiceDirectory,
  groupServiceDirectory,
  loadOrganizationServiceDirectory,
  summarizeOrganizationServices,
  type ServiceDirectoryItem,
} from "@/lib/services/service-directory";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  SynchronizationConflictError,
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";

const organizationId = "20000000-0000-4000-8000-000000000120";
const otherOrganizationId = "20000000-0000-4000-8000-000000000121";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000120",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000121",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

function item(
  id: string,
  date: string,
  input: Partial<ChurchService> = {},
): ServiceDirectoryItem {
  const service: ChurchService = {
    id,
    organizationId,
    serviceDate: date,
    serviceType: "Sunday Morning",
    serviceTime: "10:30",
    status: "draft",
    isArchived: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    createdBy: admin.userId,
    updatedBy: admin.userId,
    ...input,
  };
  return {
    service,
    membersPresent: 0,
    visitorsPresent: 0,
    totalPresent: 0,
    pendingSync: false,
    syncState: "synced",
  };
}

class MemoryServiceCloud implements PullSource, UploadTarget {
  rows = new Map<string, Record<string, unknown>>();

  async upsert(
    table: "organizations" | "organization_settings" | "people" | "services" | "service_attendance" | "service_visitors",
    payload: Record<string, unknown>,
  ) {
    this.rows.set(`${table}:${String(payload.id)}`, { ...payload, version: 1 });
    return { version: 1, updatedAt: String(payload.updated_at) };
  }

  async fetchPage(
    table: PullTable,
    requestedOrganizationId: string,
    _updatedAt: string | undefined,
    offset: number,
    limit: number,
  ) {
    const rows = [...this.rows.entries()]
      .filter(([key, row]) => {
        if (!key.startsWith(`${table}:`)) return false;
        return table === "organizations"
          ? row.id === requestedOrganizationId
          : row.organization_id === requestedOrganizationId;
      })
      .map(([, row]) => row)
      .slice(offset, offset + limit);
    return { rows, hasMore: false };
  }
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("organization-wide service visibility", () => {
  it("shows an Admin draft to an Attendance Taker without filtering by creator", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-29",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    expect((await listServices(attendanceTaker.organizationId))[0]).toMatchObject({
      id: service.id,
      status: "draft",
      createdBy: admin.userId,
    });
  });

  it("shows an Attendance Taker draft to an Admin", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    expect((await listServices(admin.organizationId))[0]).toMatchObject({
      id: service.id,
      createdBy: attendanceTaker.userId,
    });
  });

  it("keeps cross-organization services hidden locally and in RLS", async () => {
    await saveService(admin, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    expect(await listServices(otherOrganizationId)).toEqual([]);

    const migration = readFileSync(
      resolve("supabase/migrations/202607290001_stage_one.sql"),
      "utf8",
    );
    expect(migration).toContain(
      'create policy "Users read services in their organization"',
    );
    expect(migration).toMatch(
      /on public\.services for select to authenticated\s+using \(organization_id = public\.current_organization_id\(\)\)/,
    );
    expect(migration).not.toMatch(
      /services for select[\s\S]{0,200}created_by\s*=\s*auth\.uid\(\)/i,
    );
  });

  it("uploads an offline-created service and downloads the same UUID for another account", async () => {
    const cloud = new MemoryServiceCloud();
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-12",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
    await uploadPendingChanges(organizationId, cloud);

    await clearLocalDatabase();
    await pullOrganizationData(admin, cloud);
    expect(await listServices(organizationId)).toEqual([
      expect.objectContaining({ id: service.id, status: "draft" }),
    ]);
  });

  it("shares completion through reconciliation while preserving the UUID", async () => {
    const cloud = new MemoryServiceCloud();
    const draft = await saveService(admin, {
      serviceDate: "2026-08-16",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await uploadPendingChanges(organizationId, cloud);
    await saveService(admin, { ...draft, status: "completed" });
    await uploadPendingChanges(organizationId, cloud);

    await clearLocalDatabase();
    await pullOrganizationData(attendanceTaker, cloud);
    expect((await listServices(organizationId))[0]).toMatchObject({
      id: draft.id,
      status: "completed",
    });
  });

  it("does not let a stale draft overwrite a newer completed cloud version", async () => {
    const draft = await saveService(attendanceTaker, {
      serviceDate: "2026-08-23",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    const target: UploadTarget = {
      async upsert(_table, _payload, _conflict, context) {
        expect(context?.recordId).toBe(draft.id);
        throw new SynchronizationConflictError(
          "The completed cloud service is newer.",
        );
      },
    };
    const result = await uploadPendingChanges(organizationId, target);
    expect(result.uploaded).toBe(0);
    expect(result.errors[0]).toContain("newer changes from another device");
    expect(result.diagnostics?.[0]).toContain(
      "completed cloud service is newer",
    );
    expect(await getPendingChanges(organizationId)).toHaveLength(1);
  });

  it("reconciles a newer remote completion into a stale queued draft", async () => {
    const draft = await saveService(attendanceTaker, {
      serviceDate: "2026-08-30",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const member = await saveMember(attendanceTaker, {
      firstName: "Morgan",
      lastName: "River",
    });
    await setMemberAttendance(
      attendanceTaker,
      draft.id,
      member.id,
      true,
    );
    const cloud = new MemoryServiceCloud();
    cloud.rows.set(`services:${draft.id}`, {
      id: draft.id,
      organization_id: organizationId,
      service_date: draft.serviceDate,
      service_type: draft.serviceType,
      service_time: draft.serviceTime ?? null,
      custom_name: null,
      status: "completed",
      is_archived: false,
      deleted_at: null,
      version: 2,
      created_by: draft.createdBy,
      updated_by: admin.userId,
      created_at: draft.createdAt,
      updated_at: "2026-08-30T15:00:00.000Z",
    });

    await pullOrganizationData(attendanceTaker, cloud);
    expect((await listServices(organizationId))[0]).toMatchObject({
      id: draft.id,
      status: "completed",
      version: 2,
    });
    const serviceMutation = (await getPendingChanges(organizationId)).find(
      (mutation) =>
        mutation.table === "services" && mutation.recordId === draft.id,
    );
    expect(serviceMutation?.payload.status).toBe("completed");
    expect(serviceMutation?.baseVersion).toBe(2);
    expect((await getServiceAttendance(draft.id))[0]).toMatchObject({
      personId: member.id,
      present: true,
    });
  });
});

describe("year and month service folders", () => {
  it("renders accessible expandable year and month folders with local expansion memory", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    expect(source).toContain('className="service-year-folder"');
    expect(source).toContain('className="service-month-folder"');
    expect(source).toContain("service-folders:");
    expect(source).toContain('serviceFilter !== "all"');
    expect(source).toContain("Waiting to sync");
  });

  it("groups drafts and completed services together with newest years and months first", () => {
    const groups = groupServiceDirectory([
      item("a", "2025-12-21", { status: "completed" }),
      item("b", "2026-06-03", { status: "completed" }),
      item("c", "2026-07-29", { status: "draft" }),
      item("d", "2026-07-26", { status: "completed" }),
    ]);
    expect(groups.map((group) => group.year)).toEqual(["2026", "2025"]);
    expect(groups[0].months.map((month) => month.monthName)).toEqual([
      "July",
      "June",
    ]);
    expect(groups[0].serviceCount).toBe(3);
    expect(groups[0].months[0].services).toHaveLength(2);
    expect(
      groups[0].months[0].services.map((entry) => entry.service.status),
    ).toEqual(["draft", "completed"]);
  });

  it("sorts services by date, start time, then updated time newest first", () => {
    const groups = groupServiceDirectory([
      item("early", "2026-07-29", { serviceTime: "10:30" }),
      item("late-old", "2026-07-29", {
        serviceTime: "19:00",
        updatedAt: "2026-07-29T18:00:00.000Z",
      }),
      item("late-new", "2026-07-29", {
        serviceTime: "19:00",
        updatedAt: "2026-07-29T19:00:00.000Z",
      }),
      item("older-date", "2026-07-28", { serviceTime: "23:00" }),
    ]);
    expect(
      groups[0].months[0].services.map((entry) => entry.service.id),
    ).toEqual(["late-new", "late-old", "early", "older-date"]);
  });

  it("searches service names, types, dates, months, and years", () => {
    const records = [
      item("summer", "2026-07-29", {
        customName: "Community Prayer",
        serviceType: "Special Service",
      }),
      item("winter", "2025-12-21", { customName: "Christmas Service" }),
    ];
    expect(filterServiceDirectory(records, "all", "prayer")).toHaveLength(1);
    expect(filterServiceDirectory(records, "all", "special")).toHaveLength(1);
    expect(filterServiceDirectory(records, "all", "July")).toHaveLength(1);
    expect(filterServiceDirectory(records, "all", "2025")).toHaveLength(1);
    expect(filterServiceDirectory(records, "completed", "")).toHaveLength(0);
  });

  it("attaches member, visitor, editor, and pending totals to the correct service", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-29",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    const other = await saveService(admin, {
      serviceDate: "2026-07-27",
      serviceType: "Sunday Morning",
      status: "completed",
    });
    const member = await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
    });
    await setMemberAttendance(admin, service.id, member.id, true);
    await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "West",
      saveAsMember: false,
    });
    await (await getDatabase()).put("profiles", {
      id: admin.userId,
      organizationId,
      displayName: "Casey Admin",
      role: "admin",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const directory = await loadOrganizationServiceDirectory(organizationId);
    expect(directory.find((entry) => entry.service.id === service.id)).toMatchObject({
      totalPresent: 2,
      membersPresent: 1,
      visitorsPresent: 1,
      lastEditor: "Casey Admin",
      pendingSync: true,
      syncState: "pending",
    });
    expect(directory.find((entry) => entry.service.id === other.id)).toMatchObject({
      totalPresent: 0,
      membersPresent: 0,
      visitorsPresent: 0,
    });
    expect(await getServiceAttendance(service.id)).toHaveLength(1);
  });

  it("does not duplicate a service while summarizing repeated dependent data", () => {
    const service = item("stable-id", "2026-07-29").service;
    const summaries = summarizeOrganizationServices(
      [service],
      [],
      [],
      [],
      [],
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].service.id).toBe("stable-id");
  });

  it("derives each draft sync state from its own parent and dependent mutations", () => {
    const service = item("draft-sync-state", "2026-07-29").service;
    const mutation = (
      status: "pending" | "processing" | "error" | "conflict",
      table: "services" | "service_attendance" | "service_visitors",
      lastError?: string,
    ) => ({
      id: `${table}-${status}`,
      organizationId,
      table,
      operation: "upsert" as const,
      recordId:
        table === "services" ? service.id : `${service.id}-${table}`,
      payload:
        table === "services"
          ? { id: service.id }
          : { id: `${service.id}-${table}`, service_id: service.id },
      status,
      attempts: 1,
      lastError,
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });

    expect(
      summarizeOrganizationServices(
        [service],
        [],
        [],
        [],
        [mutation("processing", "service_attendance")],
      )[0].syncState,
    ).toBe("uploading");
    expect(
      summarizeOrganizationServices(
        [service],
        [],
        [],
        [],
        [
          mutation("pending", "services"),
          mutation(
            "error",
            "service_visitors",
            "SYNC_CONFLICT: server version is newer",
          ),
        ],
      )[0].syncState,
    ).toBe("conflict");
    expect(
      summarizeOrganizationServices([service], [], [], [], [])[0].syncState,
    ).toBe("synced");
  });
});
