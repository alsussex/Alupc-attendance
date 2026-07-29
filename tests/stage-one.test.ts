import { beforeEach, describe, expect, it } from "vitest";
import {
  addServiceVisitor,
  getServiceAttendance,
  listActiveMembers,
  listServices,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { canAccessProtectedRoute } from "@/lib/auth/guard";
import { countAttendance, type UserContext } from "@/lib/domain";

const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  email: "taker@example.test",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("authentication guard", () => {
  it("does not allow an unauthenticated user into protected routes", () => {
    expect(canAccessProtectedRoute(null)).toBe(false);
    expect(canAccessProtectedRoute(user)).toBe(true);
  });
});

describe("people and visitor behavior", () => {
  it("adds a member to the active directory", async () => {
    await saveMember(user, { firstName: "Avery", lastName: "Stone" });
    expect((await listActiveMembers(user.organizationId))[0].displayName).toBe(
      "Avery Stone",
    );
  });

  it("keeps one-time visitors out of later member checklists", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await addServiceVisitor(user, service.id, {
      firstName: "Morgan",
      lastName: "Lane",
      saveAsMember: false,
    });
    expect(await listActiveMembers(user.organizationId)).toHaveLength(0);

    await addServiceVisitor(user, service.id, {
      firstName: "Jordan",
      lastName: "West",
      saveAsMember: true,
    });
    expect((await listActiveMembers(user.organizationId)).map((person) => person.displayName)).toEqual([
      "Jordan West",
    ]);
  });
});

describe("attendance and offline queue", () => {
  it("checks and unchecks attendance and updates totals", async () => {
    const member = await saveMember(user, { firstName: "Riley", lastName: "Green" });
    const service = await saveService(user, {
      serviceDate: "2026-08-05",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    await setMemberAttendance(user, service.id, member.id, true);
    let records = await getServiceAttendance(service.id);
    expect(records[0].present).toBe(true);
    expect(countAttendance(records.filter((item) => item.present).map((item) => item.personId), 1)).toBe(2);

    await setMemberAttendance(user, service.id, member.id, false);
    records = await getServiceAttendance(service.id);
    expect(records[0].present).toBe(false);
    expect(countAttendance(records.filter((item) => item.present).map((item) => item.personId), 0)).toBe(0);
  });

  it("queues records created while offline", async () => {
    await saveMember(user, { firstName: "Sam", lastName: "North" });
    const queue = await getPendingChanges(user.organizationId);
    expect(queue).toHaveLength(1);
    expect(queue[0].table).toBe("people");
  });

  it("handles repeated service saves idempotently", async () => {
    const first = await saveService(user, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    await saveService(user, { ...first, status: "completed" });
    expect(await listServices(user.organizationId)).toHaveLength(1);
    const queue = await getPendingChanges(user.organizationId);
    expect(queue.filter((item) => item.table === "services")).toHaveLength(1);
  });
});
