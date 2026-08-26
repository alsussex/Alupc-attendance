import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_SETTINGS,
  type Person,
  type ServiceVisitor,
  type UserContext,
} from "@/lib/domain";
import {
  COMPLETED_SERVICE_LOCK_MESSAGE,
  addServiceVisitor,
  editServiceVisitor,
  getServiceAttendance,
  listServiceVisitors,
  removeServiceVisitor,
  saveMember,
  saveService,
  setMemberAttendance,
  setUnnamedVisitorCount,
} from "@/lib/repositories/attendance-repository";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  visibleServiceMembers,
  visibleServiceVisitors,
} from "@/lib/services/attendance-view";

const organizationId = "20000000-0000-4000-8000-000000000190";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000190",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000191",
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

async function completedServiceFixture() {
  const member = await saveMember(admin, {
    firstName: "Avery",
    lastName: "Stone",
  });
  const draft = await saveService(admin, {
    serviceDate: "2026-12-20",
    serviceType: "Sunday Morning",
    status: "draft",
  });
  await setMemberAttendance(admin, draft.id, member.id, true);
  const { visitor } = await addServiceVisitor(admin, draft.id, {
    firstName: "Morgan",
    lastName: "Lane",
    notes: "First visit",
    saveAsMember: false,
  });
  await setUnnamedVisitorCount(admin, draft.id, 1);
  const completed = await saveService(admin, {
    ...draft,
    unnamedVisitorCount: 1,
    status: "completed",
  });
  await (await getDatabase()).clear("syncQueue");
  return { completed, member, visitor };
}

describe("completed service data lock", () => {
  it("rejects attendance and visitor mutations without changing local history", async () => {
    const { completed, member, visitor } = await completedServiceFixture();

    await expect(
      setMemberAttendance(admin, completed.id, member.id, false),
    ).rejects.toThrow(COMPLETED_SERVICE_LOCK_MESSAGE);
    await expect(
      setUnnamedVisitorCount(admin, completed.id, 2),
    ).rejects.toThrow(COMPLETED_SERVICE_LOCK_MESSAGE);
    await expect(
      addServiceVisitor(admin, completed.id, {
        firstName: "Jordan",
        lastName: "West",
        saveAsMember: false,
      }),
    ).rejects.toThrow(COMPLETED_SERVICE_LOCK_MESSAGE);
    await expect(
      editServiceVisitor(admin, visitor.id, {
        firstName: "Changed",
        lastName: "Name",
      }),
    ).rejects.toThrow(COMPLETED_SERVICE_LOCK_MESSAGE);
    await expect(removeServiceVisitor(admin, visitor.id)).rejects.toThrow(
      COMPLETED_SERVICE_LOCK_MESSAGE,
    );

    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect(await getServiceAttendance(completed.id)).toEqual([
      expect.objectContaining({ personId: member.id, present: true }),
    ]);
    expect(await listServiceVisitors(completed.id)).toEqual([
      expect.objectContaining({
        id: visitor.id,
        displayName: "Morgan Lane",
        notes: "First visit",
      }),
    ]);
    expect(
      await (await getDatabase()).get("services", completed.id),
    ).toMatchObject({ status: "completed", unnamedVisitorCount: 1 });
  });

  it("prevents Attendance Takers from reopening a completed service", async () => {
    const { completed } = await completedServiceFixture();

    await expect(
      saveService(attendanceTaker, {
        ...completed,
        status: "draft",
      }),
    ).rejects.toThrow("Only an administrator can reopen");
    expect(
      await (await getDatabase()).get("services", completed.id),
    ).toMatchObject({ status: "completed" });
  });

  it("allows only an explicitly permitted Attendance Taker to reopen", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-31",
      serviceType: "Special Service",
      status: "completed",
    });
    const permitted = { ...attendanceTaker, canReopenCompletedServices: true };
    const reopened = await saveService(permitted, { ...service, status: "draft" });
    expect(reopened.status).toBe("draft");
    const secondService = await saveService(admin, {
      serviceDate: "2026-08-01",
      serviceType: "Special Service",
      status: "completed",
    });
    await expect(
      saveService({ ...attendanceTaker, canReopenCompletedServices: false }, {
        ...secondService,
        status: "draft",
      }),
    ).rejects.toThrow("Attendance Taker permission");
  });

  it("honors the organization setting that disables Admin reopening", async () => {
    const { completed } = await completedServiceFixture();
    await (await getDatabase()).put("organizationSettings", {
      id: organizationId,
      organizationId,
      settings: {
        ...DEFAULT_APPLICATION_SETTINGS,
        allowAdminReopenCompleted: false,
      },
      createdAt: "2026-12-20T00:00:00.000Z",
      updatedAt: "2026-12-20T00:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    });

    await expect(
      saveService(admin, {
        ...completed,
        status: "draft",
      }),
    ).rejects.toThrow("not enabled");
  });

  it("restores editing immediately after an Admin reopens the service", async () => {
    const { completed, member, visitor } = await completedServiceFixture();
    const reopened = await saveService(admin, {
      ...completed,
      status: "draft",
    });

    expect(reopened.status).toBe("draft");
    await setMemberAttendance(admin, reopened.id, member.id, false);
    await setUnnamedVisitorCount(admin, reopened.id, 2);
    await editServiceVisitor(admin, visitor.id, {
      firstName: "Morgan",
      lastName: "Lane",
      notes: "Updated after reopening",
    });

    expect(await getServiceAttendance(reopened.id)).toEqual([
      expect.objectContaining({ personId: member.id, present: false }),
    ]);
    expect(await listServiceVisitors(reopened.id)).toEqual([
      expect.objectContaining({ notes: "Updated after reopening" }),
    ]);
    expect(
      await (await getDatabase()).get("services", reopened.id),
    ).toMatchObject({ status: "draft", unnamedVisitorCount: 2 });
  });
});

describe("completed service interface lock", () => {
  const source = readFileSync(
    resolve("components/services/ServiceManager.tsx"),
    "utf8",
  );
  const styles = readFileSync(resolve("app/globals.css"), "utf8");
  const members: Person[] = [
    {
      id: "member-present",
      organizationId,
      firstName: "Avery",
      lastName: "Stone",
      displayName: "Avery Stone",
      personType: "member",
      isActive: true,
      createdBy: admin.userId,
      updatedBy: admin.userId,
      createdAt: "2026-12-01T00:00:00.000Z",
      updatedAt: "2026-12-01T00:00:00.000Z",
    },
    {
      id: "member-absent",
      organizationId,
      firstName: "Jordan",
      lastName: "West",
      displayName: "Jordan West",
      personType: "member",
      isActive: true,
      createdBy: admin.userId,
      updatedBy: admin.userId,
      createdAt: "2026-12-01T00:00:00.000Z",
      updatedAt: "2026-12-01T00:00:00.000Z",
    },
  ];
  const visitors: ServiceVisitor[] = [
    {
      id: "visitor-present",
      organizationId,
      serviceId: "service-completed",
      firstName: "Morgan",
      lastName: "Lane",
      displayName: "Morgan Lane",
      savedAsMember: false,
      createdBy: admin.userId,
      updatedBy: admin.userId,
      createdAt: "2026-12-01T00:00:00.000Z",
      updatedAt: "2026-12-01T00:00:00.000Z",
    },
  ];
  const selected = new Set(["member-present"]);

  it("announces the completed lock and retains the permission-aware reopen action", () => {
    expect(source).toContain(
      'const serviceLocked = active.status === "completed"',
    );
    expect(source).toContain("This service is locked.");
    expect(source).toContain("Reopen Service to make changes.");
    expect(source).toContain("settings.allowAdminReopenCompleted");
    expect(source).toContain('onClick={() => void setStatus("draft")}');
  });

  it("disables attendance cards and all visitor mutation controls while locked", () => {
    expect(source).toContain("disabled={serviceLocked}");
    expect(source).toContain("aria-disabled={serviceLocked}");
    expect(source).toContain(
      "disabled={serviceLocked || memberCounts.present === 0}",
    );
    expect(source).toContain("memberOpen && !serviceLocked");
    expect(source).toContain("visitorOpen && !serviceLocked");
    expect(source).toContain("editingVisitor && !serviceLocked");
    expect(styles).toContain(".attendance-person-card.locked");
    expect(styles).toContain(".completed-service-lock");
  });

  it("shows only present members and recorded visitors while completed", () => {
    expect(
      visibleServiceMembers(members, selected, true, "all", "").map(
        (member) => member.id,
      ),
    ).toEqual(["member-present"]);
    expect(
      visibleServiceVisitors(visitors, true, "a name that does not match"),
    ).toEqual(visitors);
    expect(source).toContain("No members were marked present.");
    expect(source).toContain("No named visitors were recorded.");
    expect(source).toContain("<strong>Service note:</strong> {active.notes}");
  });

  it("restores the full checklist after reopening and returns to attendees after finishing again", () => {
    const reopened = visibleServiceMembers(
      members,
      selected,
      false,
      "all",
      "",
    );
    const finishedAgain = visibleServiceMembers(
      members,
      selected,
      true,
      "all",
      "",
    );

    expect(reopened.map((member) => member.id)).toEqual([
      "member-present",
      "member-absent",
    ]);
    expect(finishedAgain.map((member) => member.id)).toEqual([
      "member-present",
    ]);
  });
});
