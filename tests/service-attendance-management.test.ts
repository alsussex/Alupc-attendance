import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  addServiceVisitor,
  editServiceVisitor,
  findDuplicateMember,
  getServiceAttendance,
  listActiveMembers,
  listServiceVisitors,
  removeServiceVisitor,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import {
  attendanceCounts,
  attendancePresentCounts,
  filterAttendanceMembers,
  filterAttendanceVisitors,
} from "@/lib/services/attendance-view";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord, toCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000060";
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000060",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("attendance-taking view", () => {
  it("shows every active member by default and filters by attendance and name", async () => {
    const avery = await saveMember(attendanceTaker, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const morgan = await saveMember(attendanceTaker, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    const members = await listActiveMembers(organizationId);
    const selected = new Set([morgan.id]);

    expect(filterAttendanceMembers(members, selected, "all", "")).toHaveLength(
      2,
    );
    expect(
      filterAttendanceMembers(members, selected, "present", "").map(
        (member) => member.id,
      ),
    ).toEqual([morgan.id]);
    expect(
      filterAttendanceMembers(members, selected, "absent", "").map(
        (member) => member.id,
      ),
    ).toEqual([avery.id]);
    expect(
      filterAttendanceMembers(members, selected, "all", "morgan").map(
        (member) => member.id,
      ),
    ).toEqual([morgan.id]);
    expect(attendanceCounts(members, selected)).toEqual({
      present: 1,
      absent: 1,
      total: 2,
    });
  });

  it("treats unchecked as absent and preserves draft and completed selections", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-12",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });

    expect(await getServiceAttendance(service.id)).toHaveLength(0);
    await setMemberAttendance(attendanceTaker, service.id, member.id, true);
    expect((await getServiceAttendance(service.id))[0].present).toBe(true);

    await setMemberAttendance(attendanceTaker, service.id, member.id, false);
    await saveService(attendanceTaker, { ...service, status: "draft" });
    await closeLocalDatabaseConnection();
    expect((await getServiceAttendance(service.id))[0].present).toBe(false);

    await setMemberAttendance(attendanceTaker, service.id, member.id, true);
    await saveService(attendanceTaker, { ...service, status: "completed" });
    await closeLocalDatabaseConnection();
    expect((await getServiceAttendance(service.id))[0].present).toBe(true);
  });

  it("calculates present-only member, visitor, and total counts instantly", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Robin",
      lastName: "North",
    });
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(attendanceTaker, service.id, {
      firstName: "Jamie",
      lastName: "Fields",
      saveAsMember: false,
    });

    expect(
      attendancePresentCounts(new Set([member.id]), [visitor]),
    ).toEqual({ total: 2, members: 1, visitors: 1 });
    expect(attendancePresentCounts(new Set(), [visitor])).toEqual({
      total: 1,
      members: 0,
      visitors: 1,
    });
  });

  it("searches visitors and keeps them out of the absent filter", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-09-13",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(attendanceTaker, service.id, {
      firstName: "Skyler",
      lastName: "Reed",
      saveAsMember: false,
    });

    expect(filterAttendanceVisitors([visitor], "all", "sky")).toEqual([
      visitor,
    ]);
    expect(filterAttendanceVisitors([visitor], "present", "reed")).toEqual([
      visitor,
    ]);
    expect(filterAttendanceVisitors([visitor], "absent", "")).toEqual([]);
  });

  it("keeps the row-wide present control and high-contrast selected styling", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const styles = readFileSync(resolve("app/globals.css"), "utf8");

    expect(source).toContain(
      'checked ? "attendance-row selected" : "attendance-row"',
    );
    expect(source).toContain("Total Present");
    expect(source).toContain("+ Add Member");
    expect(source).toContain("+ Add Visitor");
    expect(styles).toContain(".attendance-row.selected");
    expect(styles).toContain("background: #e4f6e9");
    expect(styles).toContain("min-height: 92px");
  });

  it("adds a member offline, marks them present, and queues both records", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-09-20",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const member = await saveMember(attendanceTaker, {
      firstName: "Quinn",
      lastName: "Parker",
    });
    await setMemberAttendance(attendanceTaker, service.id, member.id, true);
    await closeLocalDatabaseConnection();

    expect(
      (await listActiveMembers(organizationId)).map((person) => person.id),
    ).toContain(member.id);
    expect(
      (await getServiceAttendance(service.id)).find(
        (record) => record.personId === member.id,
      )?.present,
    ).toBe(true);
    const pending = await getPendingChanges(organizationId);
    expect(
      pending.some(
        (mutation) =>
          mutation.table === "people" && mutation.recordId === member.id,
      ),
    ).toBe(true);
    expect(
      pending.some(
        (mutation) =>
          mutation.table === "service_attendance" &&
          mutation.recordId.includes(member.id),
      ),
    ).toBe(true);
  });

  it("preserves normalized duplicate detection for quick member entry", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Alex",
      lastName: "Morgan",
    });
    expect(
      await findDuplicateMember(organizationId, "  ALEX   MORGAN  "),
    ).toMatchObject({ id: member.id });
  });
});

describe("service visitor lifecycle", () => {
  it("allows an attendance taker to edit and remove a service-only visitor", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-16",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(
      attendanceTaker,
      service.id,
      {
        firstName: "Jordan",
        lastName: "West",
        saveAsMember: false,
      },
    );

    const edited = await editServiceVisitor(attendanceTaker, visitor.id, {
      firstName: "Jordan",
      lastName: "Wells",
    });
    expect(edited.displayName).toBe("Jordan Wells");
    expect(await listServiceVisitors(service.id)).toHaveLength(1);

    await removeServiceVisitor(attendanceTaker, visitor.id);
    expect(await listServiceVisitors(service.id)).toHaveLength(0);
    const stored = await (await getDatabase()).get("visitors", visitor.id);
    expect(stored?.id).toBe(visitor.id);
    expect(stored?.deletedAt).toBeTruthy();

    const visitorMutations = (await getPendingChanges(organizationId)).filter(
      (item) =>
        item.table === "service_visitors" && item.recordId === visitor.id,
    );
    expect(visitorMutations).toHaveLength(1);
    expect(visitorMutations[0].payload.deleted_at).toBeTruthy();
  });

  it("removes only the service entry and keeps a linked permanent member", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-23",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    const { visitor, member } = await addServiceVisitor(
      attendanceTaker,
      service.id,
      {
        firstName: "Riley",
        lastName: "Green",
        saveAsMember: true,
      },
    );
    expect(member).toBeDefined();

    await removeServiceVisitor(attendanceTaker, visitor.id);
    const members = await listActiveMembers(organizationId);
    const attendance = await getServiceAttendance(service.id);
    expect(members.map((person) => person.id)).toContain(member?.id);
    expect(attendance.find((record) => record.personId === member?.id)?.present)
      .toBe(false);
    expect(await listServiceVisitors(service.id)).toHaveLength(0);
  });

  it("persists visitor edits and removals offline and serializes the tombstone", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-08-30",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(
      attendanceTaker,
      service.id,
      {
        firstName: "Taylor",
        lastName: "Brooks",
        saveAsMember: false,
      },
    );
    const removed = await removeServiceVisitor(attendanceTaker, visitor.id);
    await closeLocalDatabaseConnection();

    const stored = await (await getDatabase()).get("visitors", visitor.id);
    expect(stored?.deletedAt).toBe(removed.deletedAt);
    const cloud = toCloudRecord(removed);
    expect(cloud.deleted_at).toBe(removed.deletedAt);
    expect(
      fromCloudRecord("service_visitors", cloud as Record<string, unknown>),
    ).toMatchObject({ id: visitor.id, deletedAt: removed.deletedAt });
  });

  it("keeps permanent member deletion restricted in the interface", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    expect(source).toContain(
      "Remove this visitor from the service? This will remove their attendance entry from this service.",
    );
    expect(source).not.toContain("removeMember(");
  });
});

describe("visitor lifecycle migration security", () => {
  it("adds only an organization-scoped synchronized tombstone and retains RLS", () => {
    const lifecycle = readFileSync(
      resolve(
        "supabase/migrations/202607290006_service_visitor_lifecycle.sql",
      ),
      "utf8",
    );
    const base = readFileSync(
      resolve("supabase/migrations/202607290001_stage_one.sql"),
      "utf8",
    );
    expect(lifecycle).toContain("add column if not exists deleted_at");
    expect(lifecycle).toContain(
      "on public.service_visitors (organization_id, service_id)",
    );
    expect(base).toContain(
      "alter table public.service_visitors enable row level security;",
    );
    expect(base).toContain(
      "using (organization_id = public.current_organization_id())",
    );
  });
});
