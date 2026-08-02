import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleDirectory } from "@/components/people/PeopleDirectory";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import type { UserContext } from "@/lib/domain";
import { bulkUpdateMemberLifecycle } from "@/lib/people/bulk-member-management";
import {
  getServiceAttendance,
  markMemberInactive,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";

const mocks = vi.hoisted(() => ({
  role: "admin" as "admin" | "attendance_taker",
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
}));

const organizationId = "20000000-0000-4000-8000-000000000801";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000801",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000802",
  email: "taker@example.test",
  role: "attendance_taker",
};

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: "10000000-0000-4000-8000-000000000801",
      organizationId: "20000000-0000-4000-8000-000000000801",
      email: "admin@example.test",
      role: mocks.role,
    },
  }),
}));
vi.mock("@/components/feedback/ConfirmationProvider", () => ({
  useConfirmation: () => mocks.confirm,
}));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ showToast: mocks.toast }),
}));

beforeEach(async () => {
  await clearLocalDatabase();
  mocks.role = "admin";
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.toast.mockReset();
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(() => cleanup());

describe("bulk member lifecycle operations", () => {
  it("archives mixed selections offline, skips inactive members, and preserves history", async () => {
    const active = await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const inactive = await saveMember(admin, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    const service = await saveService(admin, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, active.id, true);
    await markMemberInactive(admin, inactive.id);
    const database = await getDatabase();
    await database.clear("syncQueue");
    await database.clear("auditLog");
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });

    const result = await bulkUpdateMemberLifecycle(
      admin,
      [active.id, inactive.id, active.id],
      "archive",
    );

    expect(result).toMatchObject({ requested: 2, updated: 1, skipped: 1 });
    expect(result.failed).toHaveLength(0);
    expect(await database.get("people", active.id)).toMatchObject({
      id: active.id,
      isActive: false,
    });
    expect(await getServiceAttendance(service.id)).toEqual([
      expect.objectContaining({ personId: active.id, present: true }),
    ]);
    expect(
      (await getPendingChanges(organizationId)).filter(
        (item) => item.table === "people" && item.recordId === active.id,
      ),
    ).toHaveLength(1);
    expect(await listAuditEntries(admin, { entityId: active.id })).toEqual([
      expect.objectContaining({ action: "deactivated" }),
    ]);
  });

  it("restores mixed selections with the same UUID and queues only required updates", async () => {
    const active = await saveMember(admin, {
      firstName: "Taylor",
      lastName: "North",
    });
    const inactive = await saveMember(admin, {
      firstName: "Jordan",
      lastName: "West",
    });
    await markMemberInactive(admin, inactive.id);
    const database = await getDatabase();
    await database.clear("syncQueue");
    await database.clear("auditLog");

    const result = await bulkUpdateMemberLifecycle(
      admin,
      [active.id, inactive.id],
      "restore",
    );

    expect(result).toMatchObject({ requested: 2, updated: 1, skipped: 1 });
    expect(await database.get("people", inactive.id)).toMatchObject({
      id: inactive.id,
      isActive: true,
      inactiveAt: null,
    });
    expect(
      (await getPendingChanges(organizationId)).filter(
        (item) => item.table === "people",
      ),
    ).toHaveLength(1);
    expect(await listAuditEntries(admin, { entityId: inactive.id })).toEqual([
      expect.objectContaining({ action: "reactivated" }),
    ]);
  });

  it("rejects Attendance Takers and never updates cross-organization records", async () => {
    const otherOrganization = "20000000-0000-4000-8000-000000000899";
    const otherAdmin = { ...admin, organizationId: otherOrganization };
    const otherMember = await saveMember(otherAdmin, {
      firstName: "Other",
      lastName: "Church",
    });

    await expect(
      bulkUpdateMemberLifecycle(taker, [otherMember.id], "archive"),
    ).rejects.toThrow("Administrator");
    const result = await bulkUpdateMemberLifecycle(
      admin,
      [otherMember.id],
      "archive",
    );
    expect(result).toMatchObject({ updated: 0, skipped: 0 });
    expect(result.failed).toHaveLength(1);
    expect(await (await getDatabase()).get("people", otherMember.id)).toMatchObject({
      isActive: true,
      organizationId: otherOrganization,
    });
  });
});

describe("People directory selection mode", () => {
  it("is Admin-only, selects visible members with the keyboard, preserves hidden selections, and exits with Escape", async () => {
    await saveMember(admin, { firstName: "Avery", lastName: "Stone" });
    await saveMember(admin, { firstName: "Morgan", lastName: "Lane" });
    render(<PeopleDirectory />);

    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(await screen.findByText("2 selected")).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Avery" },
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("2 selected")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("toolbar", { name: "Bulk member actions" })).toBeNull(),
    );

    cleanup();
    mocks.role = "attendance_taker";
    render(<PeopleDirectory />);
    expect(await screen.findByText("Avery Stone")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("confirms every action and prevents duplicate submissions while confirmation is pending", async () => {
    await saveMember(admin, { firstName: "Casey", lastName: "Harbor" });
    let resolveConfirmation: ((approved: boolean) => void) | undefined;
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    render(<PeopleDirectory />);
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Casey Harbor" }));
    const archive = screen.getByRole("button", { name: "Archive selected" });
    fireEvent.click(archive);
    fireEvent.click(archive);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(archive).toBeDisabled();
    resolveConfirmation?.(false);
    await waitFor(() => expect(archive).not.toBeDisabled());
  });

  it("includes responsive touch-friendly toolbar and selection styling", () => {
    const css = readFileSync(resolve("app/globals.css"), "utf8");
    expect(css).toContain(".bulk-member-toolbar");
    expect(css).toContain(".member-selection-checkbox");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.bulk-member-toolbar/);
    expect(css).toContain("min-height: 44px");
  });
});
