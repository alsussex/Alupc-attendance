import { beforeEach, describe, expect, it } from "vitest";
import { loadDashboardSnapshot } from "@/lib/dashboard/dashboard-data";
import {
  addServiceVisitor,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import type { UserContext } from "@/lib/domain";

const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000010",
  organizationId: "20000000-0000-4000-8000-000000000010",
  email: "dashboard@example.test",
  role: "admin",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("dashboard snapshot", () => {
  it("summarizes local people, services, attendance, visitors, and drafts", async () => {
    const database = await getDatabase();
    await database.put("organizations", {
      id: user.organizationId,
      name: "Abundant Life UPC",
      slug: "abundant-life-upc",
      createdBy: user.userId,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    const member = await saveMember(user, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const service = await saveService(user, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(user, service.id, member.id, true);
    await addServiceVisitor(user, service.id, {
      firstName: "Morgan",
      lastName: "Lane",
      saveAsMember: false,
    });

    const snapshot = await loadDashboardSnapshot(
      user.organizationId,
      new Date("2026-08-15T12:00:00.000Z"),
    );

    expect(snapshot.churchName).toBe("Abundant Life UPC");
    expect(snapshot.totalPeople).toBe(1);
    expect(snapshot.servicesThisMonth).toBe(1);
    expect(snapshot.attendanceThisMonth).toBe(2);
    expect(snapshot.visitorsThisMonth).toBe(1);
    expect(snapshot.averageAttendance).toBe(2);
    expect(snapshot.draftService?.id).toBe(service.id);
    expect(snapshot.services[0]).toMatchObject({
      attendanceTotal: 2,
      visitorCount: 1,
      status: "draft",
    });
    expect(snapshot.activity.map((item) => item.type)).toEqual(
      expect.arrayContaining(["person", "service", "attendance", "visitor"]),
    );
  });

  it("keeps dashboard totals isolated to the active organization", async () => {
    const otherUser: UserContext = {
      userId: "10000000-0000-4000-8000-000000000011",
      organizationId: "20000000-0000-4000-8000-000000000011",
      email: "other@example.test",
      role: "attendance_taker",
    };
    await saveMember(otherUser, {
      firstName: "Riley",
      lastName: "Harbor",
    });

    const snapshot = await loadDashboardSnapshot(
      user.organizationId,
      new Date("2026-08-15T12:00:00.000Z"),
    );

    expect(snapshot.totalPeople).toBe(0);
    expect(snapshot.services).toHaveLength(0);
    expect(snapshot.activity).toHaveLength(0);
  });
});
