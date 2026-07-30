import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUserId = "10000000-0000-4000-8000-000000000701";
const otherUserId = "10000000-0000-4000-8000-000000000702";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: currentUserId,
      organizationId: "20000000-0000-4000-8000-000000000701",
      email: "admin@example.test",
      role: "admin",
    },
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-access-token" } },
      }),
    },
  }),
}));

vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/components/feedback/ConfirmationProvider", () => ({
  useConfirmation: () => vi.fn(async () => true),
}));

vi.mock("@/components/audit/AuditHistory", () => ({
  AuditHistory: () => null,
}));

vi.mock("@/lib/audit/audit-repository", () => ({
  removeLocalAuditEntriesForUser: vi.fn(async () => undefined),
}));

import { UserManagement } from "@/components/users/UserManagement";

describe("Admin user-management actions", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          users: [
            {
              id: currentUserId,
              displayName: "Current Administrator",
              email: "admin@example.test",
              role: "admin",
              isActive: true,
              invitationStatus: "accepted",
              createdAt: "2026-07-30T12:00:00.000Z",
            },
            {
              id: otherUserId,
              displayName: "Fictional Volunteer",
              email: "volunteer@example.test",
              role: "attendance_taker",
              isActive: true,
              invitationStatus: "accepted",
              createdAt: "2026-07-30T13:00:00.000Z",
            },
          ],
        }),
      })),
    );
  });

  it("renders a clearly labelled Delete User action for every account", async () => {
    render(<UserManagement embedded />);

    const volunteerName = await screen.findByText("Fictional Volunteer");
    const volunteerRow = volunteerName.closest("article");
    expect(volunteerRow).not.toBeNull();
    expect(
      within(volunteerRow!).getByRole("button", { name: "Delete User" }),
    ).toBeVisible();
    expect(
      within(volunteerRow!).getByText("Account actions"),
    ).toBeVisible();

    const currentName = screen.getByText("Current Administrator");
    const currentRow = currentName.closest("article");
    expect(currentRow).not.toBeNull();
    expect(
      within(currentRow!).getByRole("button", { name: "Delete User" }),
    ).toBeDisabled();
    expect(
      within(currentRow!).getByText(
        "Your currently signed-in account cannot be deleted here.",
      ),
    ).toBeVisible();
  });

  it("keeps account actions in a full-width row instead of a clipped sixth column", () => {
    const css = readFileSync(resolve("app/globals.css"), "utf8");
    expect(css).toMatch(
      /\.user-actions\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/,
    );
    expect(css).toMatch(
      /\.user-delete-button\s*\{[\s\S]*?margin-left:\s*auto;/,
    );
    expect(css).toMatch(
      /@container \(max-width: 800px\)[\s\S]*?\.users-table-header\s*\{\s*display:\s*none;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.user-actions \.button\s*\{[^}]*min-height:\s*46px;/,
    );
  });
});
