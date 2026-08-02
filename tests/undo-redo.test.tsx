import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import type { UserContext } from "@/lib/domain";
import { bulkUpdateMemberLifecycle } from "@/lib/people/bulk-member-management";
import {
  addServiceVisitor,
  duplicateService,
  editServiceVisitor,
  getServiceAttendance,
  listServices,
  listServiceVisitors,
  removeServiceVisitor,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  clearUndoHistory,
  redoLatest,
  undoHistoryState,
  undoLatest,
} from "@/lib/undo/undo-service";

const organizationId = "20000000-0000-4000-8000-000000000901";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000901",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

beforeEach(async () => {
  clearUndoHistory();
  await clearLocalDatabase();
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(() => cleanup());

async function attendanceFixture() {
  const member = await saveMember(admin, {
    firstName: "Avery",
    lastName: "Stone",
  });
  const service = await saveService(admin, {
    serviceDate: "2026-08-02",
    serviceType: "Sunday Morning",
    status: "draft",
  });
  clearUndoHistory();
  return { member, service };
}

describe("session undo and redo", () => {
  it("supports multiple attendance levels, local-first queues, and audit history", async () => {
    const { member, service } = await attendanceFixture();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await setMemberAttendance(admin, service.id, member.id, true);
    await setMemberAttendance(admin, service.id, member.id, false);
    expect(undoHistoryState()).toMatchObject({ undoCount: 2, redoCount: 0 });

    expect(await undoLatest()).toBe(true);
    expect((await getServiceAttendance(service.id))[0].present).toBe(true);
    expect(await undoLatest()).toBe(true);
    expect((await getServiceAttendance(service.id))[0].present).toBe(false);
    expect(await redoLatest()).toBe(true);
    expect((await getServiceAttendance(service.id))[0].present).toBe(true);

    const queued = (await getPendingChanges(organizationId)).find(
      (item) => item.table === "service_attendance",
    );
    expect(queued?.payload).toMatchObject({ present: true });
    const audit = await listAuditEntries(admin, {
      entityType: "attendance",
      entityId: `${service.id}:${member.id}`,
    });
    expect(audit.some((entry) => entry.details?.historyOperation === "undo")).toBe(true);
    expect(audit.some((entry) => entry.details?.historyOperation === "redo")).toBe(true);
  });

  it("undoes and redoes visitor add, edit, and removal without changing the UUID", async () => {
    const { service } = await attendanceFixture();
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "",
      notes: "First visit",
      saveAsMember: false,
    });
    await editServiceVisitor(admin, visitor.id, {
      firstName: "Jordan",
      lastName: "River",
      notes: "Updated",
    });

    expect(await undoLatest()).toBe(true);
    expect((await listServiceVisitors(service.id))[0]).toMatchObject({
      id: visitor.id,
      displayName: "Jordan",
      notes: "First visit",
    });
    expect(await undoLatest()).toBe(true);
    expect(await listServiceVisitors(service.id)).toHaveLength(0);
    expect(await redoLatest()).toBe(true);
    expect((await listServiceVisitors(service.id))[0].id).toBe(visitor.id);
    expect(await redoLatest()).toBe(true);
    expect((await listServiceVisitors(service.id))[0].displayName).toBe(
      "Jordan River",
    );

    await removeServiceVisitor(admin, visitor.id);
    expect(await listServiceVisitors(service.id)).toHaveLength(0);
    expect(await undoLatest()).toBe(true);
    expect((await listServiceVisitors(service.id))[0].id).toBe(visitor.id);
  });

  it("undoes member lifecycle changes and grouped bulk actions", async () => {
    const first = await saveMember(admin, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    const second = await saveMember(admin, {
      firstName: "Taylor",
      lastName: "North",
    });
    clearUndoHistory();
    await bulkUpdateMemberLifecycle(admin, [first.id, second.id], "archive");
    expect(undoHistoryState().undoCount).toBe(1);
    expect(await undoLatest()).toBe(true);
    const database = await getDatabase();
    expect((await database.get("people", first.id))?.isActive).toBe(true);
    expect((await database.get("people", second.id))?.isActive).toBe(true);
    expect(await redoLatest()).toBe(true);
    expect((await database.get("people", first.id))?.isActive).toBe(false);
    expect((await database.get("people", second.id))?.isActive).toBe(false);
  });

  it("undoes safe service edits but refuses after a conflicting remote edit", async () => {
    const { service } = await attendanceFixture();
    const edited = await saveService(admin, {
      ...service,
      notes: "Local office note",
    });
    expect(await undoLatest()).toBe(true);
    expect((await (await getDatabase()).get("services", service.id))?.notes).toBeUndefined();
    expect(await redoLatest()).toBe(true);
    expect((await (await getDatabase()).get("services", service.id))?.notes).toBe(
      "Local office note",
    );

    const database = await getDatabase();
    await database.put("services", {
      ...edited,
      notes: "Changed on another device",
      updatedBy: "10000000-0000-4000-8000-000000000999",
      updatedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(await undoLatest()).toBe(false);
    expect((await database.get("services", service.id))?.notes).toBe(
      "Changed on another device",
    );
  });

  it("undoes and redoes service duplication with one stable duplicate UUID", async () => {
    const { service } = await attendanceFixture();
    const duplicate = await duplicateService(admin, service.id, {
      serviceDate: "2026-08-09",
      serviceType: service.serviceType,
      customName: service.customName,
      serviceTime: service.serviceTime,
      notes: service.notes,
    });
    expect(duplicate.id).not.toBe(service.id);
    expect(await listServices(organizationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: service.id }),
        expect.objectContaining({ id: duplicate.id, status: "draft" }),
      ]),
    );
    expect(await undoLatest()).toBe(true);
    expect((await listServices(organizationId)).map((item) => item.id)).not.toContain(
      duplicate.id,
    );
    expect(await redoLatest()).toBe(true);
    expect((await listServices(organizationId)).map((item) => item.id)).toContain(
      duplicate.id,
    );
  });

  it("blocks attendance undo when another device changed the checkbox", async () => {
    const { member, service } = await attendanceFixture();
    const record = await setMemberAttendance(admin, service.id, member.id, true);
    await (await getDatabase()).put("attendance", {
      ...record,
      present: false,
      updatedBy: "10000000-0000-4000-8000-000000000999",
      updatedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(await undoLatest()).toBe(false);
    expect((await getServiceAttendance(service.id))[0].present).toBe(false);
    expect(undoHistoryState().undoCount).toBe(0);
  });
});

describe("undo snackbar", () => {
  it("offers Undo and Redo actions without interrupting local-first saves", async () => {
    const { member, service } = await attendanceFixture();
    render(
      <ToastProvider>
        <button
          type="button"
          onClick={() => void setMemberAttendance(admin, service.id, member.id, true)}
        >
          Mark present
        </button>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark present" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () =>
      expect((await getServiceAttendance(service.id))[0].present).toBe(false),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Redo" }));
    await waitFor(async () =>
      expect((await getServiceAttendance(service.id))[0].present).toBe(true),
    );
  });

  it("shows a clear message when an action can no longer be undone", async () => {
    const { member, service } = await attendanceFixture();
    render(<ToastProvider><span>Attendance</span></ToastProvider>);
    const record = await setMemberAttendance(admin, service.id, member.id, true);
    await (await getDatabase()).put("attendance", {
      ...record,
      present: false,
      updatedBy: "another-user",
      updatedAt: "2026-08-03T12:00:00.000Z",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(/can no longer be undone because it changed elsewhere/i),
    ).toBeVisible();
  });
});
