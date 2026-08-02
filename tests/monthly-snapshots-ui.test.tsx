import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonthlySnapshotsReport } from "@/components/reports/MonthlySnapshotsReport";

let role: "admin" | "attendance_taker" = "admin";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: "admin-1",
      organizationId: "org-1",
      email: "admin@example.test",
      role,
    },
  }),
}));

vi.mock("@/components/feedback/ConfirmationProvider", () => ({
  useConfirmation: () => vi.fn(async () => true),
}));

vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/reports/monthly-snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/monthly-snapshots")>();
  return {
    ...actual,
    listMonthlySnapshots: vi.fn(async () => [
      {
        id: "snapshot-1",
        organizationId: "org-1",
        monthStart: "2026-08-01",
        snapshotVersion: 1,
        status: "finalized",
        payload: {
          schemaVersion: 1,
          churchName: "Abundant Life UPC",
          monthKey: "2026-08",
          year: 2026,
          month: 8,
          services: [
            {
              id: "service-1",
              date: "2026-08-02",
              time: "10:30",
              type: "Sunday Morning",
              name: "Sunday Morning",
              heading: "Aug 2 AM",
              unnamedVisitors: 1,
              sundaySchoolKids: 2,
              totalAttendance: 5,
            },
          ],
          members: [],
          visitors: [],
        },
        serviceCount: 1,
        totalAttendance: 5,
        finalizedBy: "admin-1",
        finalizedByName: "Fictional Administrator",
        finalizedAt: "2026-08-31T22:00:00.000Z",
        createdAt: "2026-08-31T22:00:00.000Z",
      },
    ]),
  };
});

describe("MonthlySnapshotsReport role-aware UI", () => {
  beforeEach(() => {
    role = "admin";
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => cleanup());

  it("shows creation controls to Admins", async () => {
    render(<MonthlySnapshotsReport />);
    expect(await screen.findByRole("heading", { name: "Finalize a month" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Preview month/ })).toBeVisible();
    expect(await screen.findByText("Fictional Administrator")).toBeVisible();
  });

  it("gives Attendance Takers read-only snapshot actions", async () => {
    role = "attendance_taker";
    render(<MonthlySnapshotsReport />);
    expect(await screen.findByText("Fictional Administrator")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Finalize a month" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Preview month/ })).toBeNull();
    expect(screen.getByRole("button", { name: "View" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Print" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Export Excel" })).toBeVisible();
  });
});
