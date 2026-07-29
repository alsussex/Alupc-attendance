import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  DEFAULT_MEMBER_DIRECTORY_VIEW,
  filterDirectoryMembers,
} from "@/lib/people/member-directory";
import {
  getLastAttendanceDates,
  getServiceAttendance,
  listActiveMembers,
  listMembers,
  markMemberInactive,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";

const organizationId = "20000000-0000-4000-8000-000000000030";
const administrator: UserContext = {
  userId: "10000000-0000-4000-8000-000000000030",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000031",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("inactive member directory", () => {
  it("defaults to active members and filters active, inactive, and all views", async () => {
    const active = await saveMember(administrator, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const inactive = await saveMember(administrator, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    await markMemberInactive(administrator, inactive.id);
    const members = await listMembers(organizationId);

    expect(DEFAULT_MEMBER_DIRECTORY_VIEW).toBe("active");
    expect(filterDirectoryMembers(members, "active", "")).toEqual([active]);
    expect(filterDirectoryMembers(members, "inactive", "morgan")).toHaveLength(
      1,
    );
    expect(filterDirectoryMembers(members, "all", "")).toHaveLength(2);
  });

  it("keeps inactive members out of attendance lists and preserves their history", async () => {
    const member = await saveMember(administrator, {
      firstName: "Jordan",
      lastName: "West",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-07-20",
      serviceType: "Sunday Morning",
      status: "completed",
    });
    await setMemberAttendance(administrator, service.id, member.id, true);
    const inactive = await markMemberInactive(administrator, member.id);

    expect(inactive.inactiveAt).toBeTruthy();
    expect(await listActiveMembers(organizationId)).toHaveLength(0);
    expect((await getLastAttendanceDates(organizationId)).get(member.id)).toBe(
      "2026-07-20",
    );
  });

  it("reactivates the existing record offline and preserves its attendance", async () => {
    const member = await saveMember(administrator, {
      firstName: "Riley",
      lastName: "Green",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-07-23",
      serviceType: "Wednesday Bible Study",
      status: "completed",
    });
    await setMemberAttendance(administrator, service.id, member.id, true);
    await markMemberInactive(administrator, member.id);
    await restoreMember(administrator, member.id);

    const members = await listMembers(organizationId);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: member.id, isActive: true });
    expect(members[0].inactiveAt).toBeNull();
    expect((await listActiveMembers(organizationId))[0].id).toBe(member.id);
    expect(await getServiceAttendance(service.id)).toHaveLength(1);

    const durableRecord = await (await getDatabase()).get("people", member.id);
    const queued = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "people" && item.recordId === member.id,
    );
    expect(durableRecord?.isActive).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({
      id: member.id,
      is_active: true,
      inactive_at: null,
    });
  });

  it("prevents an Attendance Taker from reactivating a member", async () => {
    const member = await saveMember(administrator, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    await markMemberInactive(administrator, member.id);

    await expect(restoreMember(attendanceTaker, member.id)).rejects.toThrow(
      "administrator",
    );
    expect((await listMembers(organizationId))[0].isActive).toBe(false);
  });
});

describe("inactive member database enforcement", () => {
  const migration = readFileSync(
    resolve("supabase/migrations/202607290004_inactive_member_metadata.sql"),
    "utf8",
  );

  it("records inactivity metadata and blocks Attendance Taker lifecycle edits", () => {
    expect(migration).toContain("add column if not exists inactive_at");
    expect(migration).toContain(
      "new.inactive_at is distinct from old.inactive_at",
    );
    expect(migration).toContain(
      "Attendance takers may edit member names but cannot archive or reactivate members",
    );
    expect(migration).toContain("new.inactive_at := pg_catalog.now()");
    expect(migration).toContain("new.inactive_at := old.inactive_at");
    expect(migration).not.toMatch(/insert into public\.organizations/i);
  });
});
