import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditHistory } from "@/components/audit/AuditHistory";
import type { AuditLogEntry, UserContext } from "@/lib/domain";
import {
  clearLocalDatabase,
  getDatabase,
} from "@/lib/storage/database";

const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000777",
  organizationId: "20000000-0000-4000-8000-000000000777",
  email: "admin@example.test",
  role: "admin",
};
const serviceId = "40000000-0000-4000-8000-000000000777";
const refreshTables = vi.fn(async () => ({
  status: "synced" as const,
  pendingCount: 0,
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ user: admin }),
}));

vi.mock("@/components/sync/SyncProvider", () => ({
  useSynchronization: () => ({ refreshTables }),
}));

vi.mock("@/lib/sync/remote-change-listener", () => ({
  subscribeToRemoteOrganizationChanges: () => () => {},
}));

beforeEach(async () => {
  cleanup();
  refreshTables.mockClear();
  await clearLocalDatabase();
});

afterEach(cleanup);

describe("service audit history resilience", () => {
  it("loads service history from the repaired compound audit index", async () => {
    const entry: AuditLogEntry = {
      id: "90000000-0000-4000-8000-000000000777",
      organizationId: admin.organizationId,
      entityType: "service",
      entityId: serviceId,
      action: "completed",
      userId: admin.userId,
      userDisplayName: "Fictional Administrator",
      role: "admin",
      occurredAt: "2026-08-02T12:00:00.000Z",
      details: { name: "Sunday Morning" },
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
    await (await getDatabase()).put("auditLog", entry);

    render(<AuditHistory relatedEntityId={serviceId} compact />);

    expect(await screen.findByText("Completed")).toBeVisible();
    expect(screen.getByText("Fictional Administrator")).toBeVisible();
    await waitFor(() => expect(refreshTables).toHaveBeenCalledWith(["audit_log"]));
  });

  it("does not crash the service page when a legacy cached row lacks display metadata", async () => {
    const legacyEntry = {
      id: "90000000-0000-4000-8000-000000000778",
      organizationId: admin.organizationId,
      entityType: "legacy",
      entityId: serviceId,
      action: "",
      userId: admin.userId,
      userDisplayName: "",
      role: "",
      occurredAt: "",
      details: { serviceId },
      createdAt: "",
      updatedAt: "",
    } as unknown as AuditLogEntry;
    await (await getDatabase()).put("auditLog", legacyEntry);

    render(<AuditHistory relatedEntityId={serviceId} compact />);

    expect(await screen.findAllByText("Activity")).toHaveLength(2);
    expect(screen.getByText("Church user")).toBeVisible();
    expect(screen.getByText("Unknown role")).toBeVisible();
    expect(screen.getByText("Time unavailable")).toBeVisible();
  });
});
