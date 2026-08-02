import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { removeLocalAuditEntriesForUser } from "@/lib/audit/audit-repository";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import type { UserContext } from "@/lib/domain";
import {
  userDeletionMode,
  validateUserDeletion,
  type DeletableUserProfile,
} from "@/lib/users/user-deletion";
import { buildUserAuditRecord } from "@/lib/users/user-audit";

const organizationId = "20000000-0000-4000-8000-000000000620";
const otherOrganizationId = "20000000-0000-4000-8000-000000000621";
const actorId = "10000000-0000-4000-8000-000000000620";
const adminUser: UserContext = {
  userId: actorId,
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

function target(
  overrides: Partial<DeletableUserProfile> = {},
): DeletableUserProfile {
  return {
    id: "10000000-0000-4000-8000-000000000622",
    organizationId,
    role: "attendance_taker",
    isActive: true,
    ...overrides,
  };
}

describe("user deletion authorization", () => {
  it("allows an Admin to delete another Attendance Taker and preserve history", () => {
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target(),
        mode: "preserve_history",
        activeAdminCount: 1,
      }),
    ).not.toThrow();
    expect(userDeletionMode(undefined)).toBe("preserve_history");
  });

  it("allows an Admin to delete another Admin when an active Admin remains", () => {
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target({ role: "admin" }),
        mode: "preserve_history",
        activeAdminCount: 2,
      }),
    ).not.toThrow();
  });

  it("requires typed confirmation before deleting the target user's history", () => {
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target(),
        mode: "delete_history",
        confirmation: "",
        activeAdminCount: 1,
      }),
    ).toThrow("Type DELETE");
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target(),
        mode: "delete_history",
        confirmation: "DELETE",
        activeAdminCount: 1,
      }),
    ).not.toThrow();
  });

  it("prevents self-deletion and deletion of the final active Admin", () => {
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target({ id: actorId, role: "admin" }),
        mode: "preserve_history",
        activeAdminCount: 1,
      }),
    ).toThrow("currently signed-in account");
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target({ role: "admin" }),
        mode: "preserve_history",
        activeAdminCount: 1,
      }),
    ).toThrow("at least one active administrator");
  });

  it("rejects users from another organization", () => {
    expect(() =>
      validateUserDeletion({
        actorId,
        actorOrganizationId: organizationId,
        target: target({ organizationId: otherOrganizationId }),
        mode: "preserve_history",
        activeAdminCount: 2,
      }),
    ).toThrow("this church organization");
  });
});

describe("secure account deletion endpoint and interface", () => {
  const route = readFileSync(
    resolve("app/api/admin/users/route.ts"),
    "utf8",
  );
  const adminServer = readFileSync(
    resolve("lib/supabase/admin-server.ts"),
    "utf8",
  );
  const client = readFileSync(
    resolve("components/users/UserManagement.tsx"),
    "utf8",
  );

  it("lists only current-organization profiles and rejects Attendance Takers", () => {
    expect(route).toContain("authorizeAdministrator(request)");
    expect(route).toContain('.eq("organization_id", organizationId)');
    expect(adminServer).toContain('profile.role !== "admin"');
    expect(client).toContain("Display name");
    expect(client).toContain("Email");
    expect(client).toContain("Role");
    expect(client).toContain("Status");
    expect(client).toContain("Added");
  });

  it("permanently removes Auth and profile access through the server only", () => {
    expect(route).toContain("admin.auth.admin.deleteUser(");
    expect(route).toContain("targetId,\n        false");
    expect(route).toContain('.from("profiles")');
    expect(route).toContain(".delete()");
    expect(route).toContain("validateUserDeletion({");
    expect(client).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(client).not.toContain("serviceRoleKey");
  });

  it("writes a complete deletion audit record with the required occurrence time", () => {
    const occurredAt = "2026-07-30T22:15:00.000Z";
    expect(
      buildUserAuditRecord({
        id: "90000000-0000-4000-8000-000000000624",
        organizationId,
        actorId,
        actorDisplayName: "Fictional Admin",
        actorRole: "admin",
        entityId: "10000000-0000-4000-8000-000000000622",
        action: "deleted",
        details: { historyDeleted: false },
        occurredAt,
      }),
    ).toMatchObject({
      organization_id: organizationId,
      entity_type: "user",
      entity_id: "10000000-0000-4000-8000-000000000622",
      action: "deleted",
      user_id: actorId,
      user_display_name: "Fictional Admin",
      role: "admin",
      occurred_at: occurredAt,
      details: { historyDeleted: false },
    });
    expect(route).toContain("buildUserAuditRecord({");
  });

  it("defaults to preserved history and requires DELETE for destructive history removal", () => {
    expect(client).toContain(
      '>("preserve_history")',
    );
    expect(client).toContain(
      "Delete account and keep audit history",
    );
    expect(client).toContain("Recommended.");
    expect(client).toContain(
      "Delete account and delete audit history",
    );
    expect(client).toContain('confirmation !== "DELETE"');
    expect(route).toContain('"purge_user_audit_history"');
  });

  it("blocks the signed-in account in both the interface and server validation", () => {
    expect(client).toContain(
      "managedUser.id === user?.userId",
    );
    expect(client).toContain(
      "You cannot delete your currently signed-in account.",
    );
    expect(route).toContain("actorId: userId");
  });

  it("does not issue delete operations against church attendance data", () => {
    for (const table of [
      "people",
      "services",
      "service_attendance",
      "service_visitors",
      "member_private_details",
      "organization_settings",
    ]) {
      expect(route).not.toMatch(
        new RegExp(`from\\([\"']${table}[\"']\\)[\\s\\S]{0,80}\\.delete\\(`),
      );
    }
    expect(route).toContain('action === "delete"');
    expect(route).toContain("historyDeleted");
  });
});

describe("account deletion migration", () => {
  const migration = readFileSync(
    resolve(
      "supabase/migrations/202607300006_secure_user_account_deletion.sql",
    ),
    "utf8",
  );

  it("removes only Auth author-reference blockers while retaining historical UUID snapshots", () => {
    expect(migration).toContain("drop constraint if exists people_created_by_fkey");
    expect(migration).toContain("drop constraint if exists services_created_by_fkey");
    expect(migration).toContain(
      "drop constraint if exists service_attendance_created_by_fkey",
    );
    expect(migration).toContain(
      "drop constraint if exists service_visitors_created_by_fkey",
    );
    expect(migration).toContain(
      "drop constraint if exists audit_log_user_id_fkey",
    );
    expect(migration).toContain(
      "Immutable actor display-name snapshot retained",
    );
    expect(migration).not.toMatch(/alter table public\.profiles/i);
  });

  it("purges only the selected user's audit entries in the selected organization", () => {
    expect(migration).toContain(
      "where organization_id = p_organization_id",
    );
    expect(migration).toContain("and user_id = p_user_id");
    expect(migration).toContain("auth.role() <> 'service_role'");
    expect(migration).toContain(
      "grant execute on function public.purge_user_audit_history(uuid, uuid)",
    );
    expect(migration).toContain("to service_role");
    expect(migration).toContain(
      "revoke all on function public.purge_user_audit_history(uuid, uuid) from authenticated",
    );
  });

  it("keeps audit history immutable outside the narrowly authorized purge", () => {
    expect(migration).toContain(
      "raise exception 'Audit history is append-only'",
    );
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/drop policy/i);
    expect(migration).not.toMatch(/delete from public\.(people|services|service_attendance|service_visitors)/i);
  });
});

describe("deleted-user audit cache reconciliation", () => {
  it("removes only the deleted user's local history and retains unrelated history", async () => {
    const database = await getDatabase();
    const common = {
      organizationId,
      entityType: "user" as const,
      entityId: "target",
      action: "edited",
      userDisplayName: "Fictional User",
      role: "attendance_taker" as const,
      occurredAt: "2026-07-30T18:00:00.000Z",
      createdAt: "2026-07-30T18:00:00.000Z",
      updatedAt: "2026-07-30T18:00:00.000Z",
    };
    await database.put("auditLog", {
      ...common,
      id: "90000000-0000-4000-8000-000000000620",
      userId: "10000000-0000-4000-8000-000000000622",
    });
    await database.put("auditLog", {
      ...common,
      id: "90000000-0000-4000-8000-000000000621",
      userId: actorId,
      userDisplayName: "Fictional Admin",
      role: "admin",
    });

    await removeLocalAuditEntriesForUser(
      organizationId,
      "10000000-0000-4000-8000-000000000622",
    );

    expect((await database.getAll("auditLog")).map((entry) => entry.id)).toEqual([
      "90000000-0000-4000-8000-000000000621",
    ]);
  });

  it("removes hard-deleted audit rows from other online Admin devices through Realtime", () => {
    const listener = readFileSync(
      resolve("lib/sync/remote-change-listener.ts"),
      "utf8",
    );
    expect(listener).toContain('table === "audit_log"');
    expect(listener).toContain('payload.eventType === "DELETE"');
    expect(listener).toContain('database.delete("auditLog"');
  });

  it("uses the retained deletion audit marker to clean a device that missed Realtime", async () => {
    const database = await getDatabase();
    const deletedUserId = "10000000-0000-4000-8000-000000000622";
    await database.put("auditLog", {
      id: "90000000-0000-4000-8000-000000000622",
      organizationId,
      entityType: "attendance",
      entityId: "attendance-record",
      action: "marked_present",
      userId: deletedUserId,
      userDisplayName: "Deleted Fictional User",
      role: "attendance_taker",
      occurredAt: "2026-07-30T17:00:00.000Z",
      createdAt: "2026-07-30T17:00:00.000Z",
      updatedAt: "2026-07-30T17:00:00.000Z",
    });
    const source: PullSource = {
      async fetchPage(table) {
        return {
          hasMore: false,
          rows:
            table === "audit_log"
              ? [
                  {
                    id: "90000000-0000-4000-8000-000000000623",
                    organization_id: organizationId,
                    entity_type: "user",
                    entity_id: deletedUserId,
                    action: "deleted",
                    user_id: actorId,
                    user_display_name: "Fictional Admin",
                    role: "admin",
                    occurred_at: "2026-07-30T18:00:00.000Z",
                    details: {
                      targetName: "Deleted Fictional User",
                      historyDeleted: true,
                    },
                    created_at: "2026-07-30T18:00:00.000Z",
                    updated_at: "2026-07-30T18:00:00.000Z",
                  },
                ]
              : [],
        };
      },
    };

    await pullOrganizationData(adminUser, source, { tables: ["audit_log"] });

    expect((await database.getAll("auditLog")).map((entry) => entry.id)).toEqual([
      "90000000-0000-4000-8000-000000000623",
    ]);
  });
});
