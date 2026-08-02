import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceModal } from "@/components/services/ServiceManager";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import {
  DEFAULT_APPLICATION_SETTINGS,
  type UserContext,
} from "@/lib/domain";
import {
  addServiceVisitor,
  duplicateService,
  findMatchingServiceSetup,
  getServiceAttendance,
  listServiceVisitors,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";

const organizationId = "20000000-0000-4000-8000-000000000971";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000971",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000972",
  organizationId,
  email: "taker@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(cleanup);

async function sourceService(user: UserContext = admin) {
  return saveService(user, {
    serviceDate: "2026-08-02",
    serviceType: "Special Service",
    customName: "Anniversary Service",
    serviceTime: "18:30",
    notes: "Welcome team arrives at 6 PM.",
    status: "draft",
    unnamedVisitorCount: 4,
    sundaySchoolKidsCount: 3,
  });
}

describe("service duplication repository", () => {
  it.each([
    ["Admin", admin],
    ["Attendance Taker", attendanceTaker],
  ])("allows an active %s to create an empty draft with copied setup", async (_, actor) => {
    const source = await sourceService(admin);
    const member = await saveMember(admin, {
      firstName: "Jordan",
      lastName: "Price",
    });
    await setMemberAttendance(admin, source.id, member.id, true);
    await addServiceVisitor(admin, source.id, {
      firstName: "Riley",
      lastName: "Stone",
      saveAsMember: false,
      notes: "First visit",
    });
    const completedSource = await saveService(admin, {
      ...source,
      status: "completed",
    });

    const duplicate = await duplicateService(actor, completedSource.id, {
      serviceDate: "2026-08-16",
      serviceType: completedSource.serviceType,
      customName: completedSource.customName,
      serviceTime: completedSource.serviceTime,
      notes: completedSource.notes,
    });

    expect(duplicate).toMatchObject({
      organizationId,
      serviceDate: "2026-08-16",
      serviceType: "Special Service",
      customName: "Anniversary Service",
      serviceTime: "18:30",
      notes: "Welcome team arrives at 6 PM.",
      status: "draft",
      unnamedVisitorCount: 0,
      sundaySchoolKidsCount: 0,
      isArchived: false,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    expect(duplicate.id).not.toBe(completedSource.id);
    expect(duplicate.deletedAt).toBeUndefined();
    expect(await getServiceAttendance(duplicate.id)).toEqual([]);
    expect(await listServiceVisitors(duplicate.id)).toEqual([]);
  });

  it("queues the stable UUID offline and records source/new IDs in audit history", async () => {
    const source = await sourceService();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const duplicate = await duplicateService(admin, source.id, {
      serviceDate: "2026-08-23",
      serviceType: source.serviceType,
      customName: "Edited duplicate name",
      serviceTime: "10:15",
      notes: "Edited before creating",
    });
    const queue = await getPendingChanges(organizationId, true);
    expect(queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "services",
          recordId: duplicate.id,
          status: "pending",
          payload: expect.objectContaining({
            id: duplicate.id,
            status: "draft",
            unnamed_visitor_count: 0,
            sunday_school_kids_count: 0,
          }),
        }),
      ]),
    );
    const audit = await listAuditEntries(admin, {
      entityType: "service",
      entityId: duplicate.id,
      action: "created",
    });
    expect(audit[0]?.details).toMatchObject({
      creationMethod: "duplicate",
      sourceServiceId: source.id,
      duplicatedServiceId: duplicate.id,
    });
  });

  it("requires a date, detects exact local matches, and preserves organization isolation", async () => {
    const source = await sourceService();
    await expect(
      duplicateService(attendanceTaker, source.id, {
        serviceDate: "",
        serviceType: source.serviceType,
      }),
    ).rejects.toThrow("Choose a new service date");

    expect(
      await findMatchingServiceSetup(organizationId, {
        serviceDate: source.serviceDate,
        serviceType: source.serviceType,
        customName: "  ANNIVERSARY   service ",
        serviceTime: source.serviceTime,
      }),
    ).toEqual([expect.objectContaining({ id: source.id })]);

    await expect(
      duplicateService(
        { ...attendanceTaker, organizationId: "another-organization" },
        source.id,
        {
          serviceDate: "2026-08-30",
          serviceType: source.serviceType,
        },
      ),
    ).rejects.toThrow("Service not found");
  });
});

describe("duplicate service setup dialog", () => {
  it("shows copied editable details, requires a new date, and works for Attendance Takers", async () => {
    const source = await sourceService();
    const onSaved = vi.fn();
    render(
      <ServiceModal
        user={attendanceTaker}
        settings={DEFAULT_APPLICATION_SETTINGS}
        duplicateOf={source}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Duplicate service" })).toBeVisible();
    expect(screen.getByLabelText("Service date")).toHaveValue("");
    expect(screen.getByLabelText("Service type")).toHaveValue("Special Service");
    expect(screen.getByLabelText(/Service time/)).toHaveValue("18:30");
    expect(screen.getByLabelText(/Custom service name/)).toHaveValue(
      "Anniversary Service",
    );
    expect(screen.getByLabelText(/Service notes/)).toHaveValue(
      "Welcome team arrives at 6 PM.",
    );

    fireEvent.submit(screen.getByRole("button", { name: "Create duplicate" }).closest("form")!);
    expect(await screen.findByText("Choose a new service date.")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("warns about an identical date/time and permits a deliberate continuation", async () => {
    const source = await sourceService();
    const onSaved = vi.fn();
    render(
      <ServiceModal
        user={admin}
        settings={DEFAULT_APPLICATION_SETTINGS}
        duplicateOf={source}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("Service date"), {
      target: { value: source.serviceDate },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create duplicate" }));
    expect(await screen.findByText("Possible duplicate service")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create duplicate anyway" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [created] = onSaved.mock.calls[0];
    expect(created.id).not.toBe(source.id);
  });

  it("prevents double submission and keeps the responsive modal action layout", async () => {
    const source = await sourceService();
    const onSaved = vi.fn();
    render(
      <ServiceModal
        user={attendanceTaker}
        settings={DEFAULT_APPLICATION_SETTINGS}
        duplicateOf={source}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText("Service date"), {
      target: { value: "2026-09-06" },
    });
    const form = screen.getByRole("button", { name: "Create duplicate" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const services = await (await getDatabase()).getAllFromIndex(
      "services",
      "organizationId",
      organizationId,
    );
    expect(services.filter((item) => item.serviceDate === "2026-09-06")).toHaveLength(1);
    expect(form.querySelector(".modal-actions")).toBeTruthy();
  });
});
