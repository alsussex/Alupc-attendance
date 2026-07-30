import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ToastProvider, useToast } from "@/components/feedback/ToastProvider";
import {
  passwordConfirmationError,
  preparePasswordSetupSession,
  requestPasswordRecovery,
} from "@/lib/auth/password";
import {
  isPasswordRecoveryCallback,
  passwordRecoveryDestination,
} from "@/lib/auth/callback-routing";
import type { UserContext } from "@/lib/domain";
import { buildAttendanceReportRows } from "@/lib/reports/attendance-report";
import {
  addServiceVisitor,
  getMemberPrivateDetails,
  saveMember,
  saveMemberPrivateDetails,
  saveService,
} from "@/lib/repositories/attendance-repository";
import { buildOrganizationExport } from "@/lib/settings/exports";
import { clearLocalDatabase } from "@/lib/storage/database";
import {
  humanReadableSyncError,
  syncErrorCategory,
} from "@/lib/sync/errors";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord } from "@/lib/sync/serialization";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import { listAuditEntries } from "@/lib/audit/audit-repository";

const organizationId = "20000000-0000-4000-8000-000000000410";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000410",
  organizationId,
  email: "leader@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000411",
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("password recovery and account setup", () => {
  it("requests a recovery email with the dedicated callback", async () => {
    const resetPasswordForEmail = vi.fn(async () => ({ error: null }));
    await requestPasswordRecovery(
      { auth: { resetPasswordForEmail } } as unknown as SupabaseClient,
      " User@Example.test ",
      "https://attendance.example/reset-password",
    );
    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      "user@example.test",
      { redirectTo: "https://attendance.example/reset-password" },
    );
  });

  it("adopts a callback session and exchanges a PKCE code when needed", async () => {
    const session = { access_token: "safe-test-token" };
    const getSession = vi.fn(async () => ({
      data: { session },
      error: null,
    }));
    const exchangeCodeForSession = vi.fn(async () => ({ error: null }));
    await expect(
      preparePasswordSetupSession(
        {
          auth: { getSession, exchangeCodeForSession },
        } as unknown as SupabaseClient,
        "https://attendance.example/reset-password?code=recovery-code",
      ),
    ).resolves.toBe(session);
    expect(exchangeCodeForSession).toHaveBeenCalledWith("recovery-code");
  });

  it("moves recovery credentials from a fallback login URL to the reset screen", () => {
    const callback =
      "https://attendance.example/login#access_token=access&refresh_token=refresh&type=recovery";
    expect(isPasswordRecoveryCallback(callback)).toBe(true);
    expect(passwordRecoveryDestination(callback)).toBe(
      "/reset-password#access_token=access&refresh_token=refresh&type=recovery",
    );
    expect(
      passwordRecoveryDestination(
        "https://attendance.example/login#type=invite&access_token=access",
      ),
    ).toBeNull();
    expect(
      passwordRecoveryDestination(
        "https://attendance.example/reset-password#type=recovery",
      ),
    ).toBeNull();
  });

  it("supports recovery templates that return a token hash directly", async () => {
    const session = { access_token: "safe-test-token" };
    const verifyOtp = vi.fn(async () => ({ error: null }));
    const getSession = vi.fn(async () => ({
      data: { session },
      error: null,
    }));
    await expect(
      preparePasswordSetupSession(
        { auth: { verifyOtp, getSession } } as unknown as SupabaseClient,
        "https://attendance.example/login?token_hash=hash&type=recovery",
      ),
    ).resolves.toBe(session);
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "hash",
      type: "recovery",
    });
  });

  it("rejects invalid, expired, or already-used callback links", async () => {
    await expect(
      preparePasswordSetupSession(
        {
          auth: {
            getSession: vi.fn(async () => ({
              data: { session: null },
              error: null,
            })),
            exchangeCodeForSession: vi.fn(async () => ({
              error: new Error("expired"),
            })),
          },
        } as unknown as SupabaseClient,
        "https://attendance.example/reset-password?code=expired",
      ),
    ).rejects.toThrow("invalid, expired, or has already been used");
  });

  it("uses the existing password strength and confirmation rules", () => {
    expect(passwordConfirmationError("short", "short")).toContain(
      "at least 8",
    );
    expect(passwordConfirmationError("long-enough", "different")).toBe(
      "The passwords do not match.",
    );
    expect(passwordConfirmationError("long-enough", "long-enough")).toBeNull();
  });

  it("keeps recovery and invitation setup on dedicated password screens", () => {
    const login = readFileSync(resolve("app/login/page.tsx"), "utf8");
    const reset = readFileSync(
      resolve("app/reset-password/page.tsx"),
      "utf8",
    );
    const invite = readFileSync(resolve("app/accept-invite/page.tsx"), "utf8");
    expect(login).toContain("Forgot password?");
    expect(login).toContain("/reset-password");
    expect(reset).toContain("Set a new password");
    expect(reset).toContain("preparePasswordSetupSession");
    expect(invite).toContain("preparePasswordSetupSession");
    expect(invite).toContain("passwordConfirmationError");
    const layout = readFileSync(resolve("app/layout.tsx"), "utf8");
    expect(layout).toContain("<AuthCallbackRouter />");
  });
});

describe("secure Admin-created users", () => {
  it("creates users only through the authenticated server route", () => {
    const route = readFileSync(
      resolve("app/api/admin/users/route.ts"),
      "utf8",
    );
    const server = readFileSync(resolve("lib/supabase/admin-server.ts"), "utf8");
    const client = readFileSync(resolve("components/users/UserManagement.tsx"), "utf8");
    expect(route).toContain("authorizeAdministrator(request)");
    expect(route).toContain("admin.auth.admin.createUser");
    expect(route).toContain("email_confirm: true");
    expect(route).toContain('mode === "create"');
    expect(server).toContain('profile.role !== "admin"');
    expect(server).toContain("profile.organization_id");
    expect(client).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(client).not.toContain("serviceRoleKey");
  });

  it("derives organization membership from the authenticated Admin, never the payload", () => {
    const route = readFileSync(
      resolve("app/api/admin/users/route.ts"),
      "utf8",
    );
    expect(route).toContain(
      "const { admin, organizationId, userId } = await authorizeAdministrator(request)",
    );
    expect(route).toContain("organization_id: organizationId");
    expect(route).not.toMatch(/body\.organization(Id|_id)/);
  });
});

describe("first-name-only visitors", () => {
  it("saves locally, displays naturally, and queues a blank last name", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "",
      saveAsMember: false,
    });
    expect(visitor).toMatchObject({
      firstName: "Jordan",
      lastName: "",
      displayName: "Jordan",
    });
    const queued = (await getPendingChanges(organizationId)).find(
      (item) => item.table === "service_visitors",
    );
    expect(queued?.payload).toMatchObject({
      first_name: "Jordan",
      last_name: "",
      display_name: "Jordan",
    });
  });

  it("deserializes and uploads a first-name-only cloud visitor", async () => {
    const timestamp = "2026-07-30T12:00:00.000Z";
    expect(
      fromCloudRecord("service_visitors", {
        id: "30000000-0000-4000-8000-000000000410",
        organization_id: organizationId,
        service_id: "40000000-0000-4000-8000-000000000410",
        first_name: "Jordan",
        last_name: "",
        display_name: "Jordan",
        saved_as_member: false,
        created_by: admin.userId,
        updated_by: admin.userId,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ).toMatchObject({ firstName: "Jordan", lastName: "", displayName: "Jordan" });

    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Special Service",
      status: "draft",
    });
    await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "",
      saveAsMember: false,
    });
    const target: UploadTarget = {
      upsert: vi.fn(async () => ({ version: 1 })),
    };
    const result = await uploadPendingChanges(organizationId, target);
    expect(result.errors).toEqual([]);
  });

  it("keeps full-name visitors and report/export totals unchanged", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    const firstOnly = await addServiceVisitor(admin, service.id, {
      firstName: "Jordan",
      lastName: "",
      saveAsMember: false,
    });
    const fullName = await addServiceVisitor(admin, service.id, {
      firstName: "Casey",
      lastName: "Harbor",
      saveAsMember: false,
    });
    expect(fullName.visitor.displayName).toBe("Casey Harbor");
    expect(
      buildAttendanceReportRows(
        [service],
        [],
        [firstOnly.visitor, fullName.visitor],
      )[0],
    ).toMatchObject({ namedVisitorCount: 2, visitorTotal: 2, totalPresent: 2 });
    const exported = await buildOrganizationExport(admin, "visitors");
    expect(exported).toContain('"Jordan",""');
    expect(exported).toContain('"Casey","Harbor"');
  });
});

describe("sync errors, service confirmation, and toast behavior", () => {
  it("maps technical failures to safe categories and useful record messages", () => {
    expect(syncErrorCategory("JWT expired", "401")).toBe("authentication");
    expect(syncErrorCategory("new row violates row-level security", "42501")).toBe(
      "permission",
    );
    expect(syncErrorCategory("Cloud record is missing last_name.")).toBe(
      "validation",
    );
    expect(
      humanReadableSyncError({
        item: { table: "service_visitors", recordId: "visitor-id" },
        message: "Cloud record is missing last_name.",
        recordName: "Jordan",
      }),
    ).toBe(
      "Visitor “Jordan” could not sync because the saved record is incomplete or invalid. Open it, review the details, and save it again.",
    );
  });

  it("deduplicates identical toast announcements", () => {
    function Harness() {
      const { showToast } = useToast();
      return (
        <button
          onClick={() =>
            showToast("Settings saved.", { key: "settings-saved" })
          }
        >
          Notify
        </button>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getAllByText("Settings saved.")).toHaveLength(1);
  });

  it("uses one application confirmation before completing a service", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    expect(source).toContain("Finish this service?");
    expect(source).toContain(
      "Finishing will lock attendance and visitor editing.",
    );
    expect(source).toContain("setFinishConfirmationOpen(false)");
    expect(source).toContain('await setStatus("completed")');
  });
});

describe("optional member contact data and private notes", () => {
  it("stores optional contact fields and queues them for offline sync", async () => {
    const member = await saveMember(taker, {
      firstName: "Avery",
      lastName: "Stone",
      email: " Avery@example.test ",
      phone: "+1 (506) 555-0101",
    });
    expect(member).toMatchObject({
      email: "avery@example.test",
      phone: "+1 (506) 555-0101",
    });
    const mutation = (await getPendingChanges(organizationId)).find(
      (item) => item.table === "people" && item.recordId === member.id,
    );
    expect(mutation?.payload).toMatchObject({
      email: "avery@example.test",
      phone: "+1 (506) 555-0101",
    });
  });

  it("restricts private notes to Admins and never copies note text into audit details", async () => {
    const member = await saveMember(admin, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    await expect(
      saveMemberPrivateDetails(taker, member.id, "Private pastoral detail"),
    ).rejects.toThrow("administrator");
    await saveMemberPrivateDetails(admin, member.id, "Private pastoral detail");
    expect(await getMemberPrivateDetails(admin, member.id)).toMatchObject({
      memberId: member.id,
      notes: "Private pastoral detail",
    });
    expect(await getMemberPrivateDetails(taker, member.id)).toBeUndefined();
    const history = await listAuditEntries(admin, {
      entityType: "member",
      entityId: member.id,
    });
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain("Private pastoral detail");
    expect(serialized).toContain('"changedFields":["notes"]');
  });

  it("queues Admin notes independently and includes contact data in exports", async () => {
    const member = await saveMember(admin, {
      firstName: "Riley",
      lastName: "Green",
      email: "riley@example.test",
      phone: "506-555-0199",
    });
    await saveMemberPrivateDetails(admin, member.id, "Follow up next month");
    const queued = await getPendingChanges(organizationId, true);
    expect(
      queued.some(
        (item) =>
          item.table === "member_private_details" &&
          item.recordId === member.id,
      ),
    ).toBe(true);
    const exported = await buildOrganizationExport(admin, "members");
    expect(exported).toContain("riley@example.test");
    expect(exported).toContain("506-555-0199");
    expect(exported).toContain("Follow up next month");
  });

  it("defines Admin-only, organization-scoped RLS for notes", () => {
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607300002_account_recovery_contacts_and_visitors.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("member_private_details");
    expect(migration).toContain("private.is_admin()");
    expect(migration).toContain(
      "organization_id = public.current_organization_id()",
    );
    expect(migration).not.toMatch(/disable\s+row\s+level\s+security/i);
  });
});
