import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canAddMembers,
  canArchiveRecords,
  canManageUsers,
} from "@/lib/auth/permissions";
import type { UserContext } from "@/lib/domain";
import {
  listMembers,
  listServices,
  markMemberInactive,
  removeMember,
  removeService,
  restoreMember,
  saveMember,
  saveService,
  setServiceArchived,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { syncRetryDelay } from "@/lib/sync/sync-service";

const organizationId = "20000000-0000-4000-8000-000000000020";
const administrator: UserContext = {
  userId: "10000000-0000-4000-8000-000000000020",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000021",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("role permissions", () => {
  it("allows attendance takers to add and edit members", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Avery",
      lastName: "Stone",
    });
    await saveMember(attendanceTaker, {
      id: member.id,
      firstName: "Avery",
      lastName: "River",
    });

    expect(canAddMembers(attendanceTaker.role)).toBe(true);
    expect((await listMembers(organizationId))[0].displayName).toBe(
      "Avery River",
    );
  });

  it("blocks attendance takers from member lifecycle operations", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Morgan",
      lastName: "Lane",
    });

    expect(canArchiveRecords(attendanceTaker.role)).toBe(false);
    await expect(
      markMemberInactive(attendanceTaker, member.id),
    ).rejects.toThrow("administrator");
    await expect(restoreMember(attendanceTaker, member.id)).rejects.toThrow(
      "administrator",
    );
    await expect(removeMember(attendanceTaker, member.id)).rejects.toThrow(
      "administrator",
    );
  });

  it("lets administrators archive, restore, and safely remove members", async () => {
    const member = await saveMember(administrator, {
      firstName: "Jordan",
      lastName: "West",
    });
    await markMemberInactive(administrator, member.id);
    expect((await listMembers(organizationId))[0].isActive).toBe(false);
    await restoreMember(administrator, member.id);
    expect((await listMembers(organizationId))[0].isActive).toBe(true);
    await removeMember(administrator, member.id);
    expect(await listMembers(organizationId)).toHaveLength(0);
    expect(
      (await getPendingChanges(organizationId)).filter(
        (item) => item.table === "people",
      ),
    ).toHaveLength(1);
  });

  it("reserves service archive and removal for administrators", async () => {
    const service = await saveService(attendanceTaker, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await expect(
      setServiceArchived(attendanceTaker, service.id, true),
    ).rejects.toThrow("administrator");
    await expect(removeService(attendanceTaker, service.id)).rejects.toThrow(
      "administrator",
    );

    await setServiceArchived(administrator, service.id, true);
    expect(await listServices(organizationId)).toHaveLength(0);
    expect(await listServices(organizationId, true)).toHaveLength(1);
    await removeService(administrator, service.id);
    expect(await listServices(organizationId, true)).toHaveLength(0);
  });

  it("reserves user administration for admins", () => {
    expect(canManageUsers(administrator.role)).toBe(true);
    expect(canManageUsers(attendanceTaker.role)).toBe(false);
  });
});

describe("authorization and retry safeguards", () => {
  const migration = readFileSync(
    resolve(
      "supabase/migrations/202607290003_user_roles_and_record_lifecycle.sql",
    ),
    "utf8",
  );
  const adminRoute = readFileSync(
    resolve("app/api/admin/users/route.ts"),
    "utf8",
  );

  it("enforces lifecycle permissions in database triggers and RLS", () => {
    expect(migration).toContain("private.enforce_people_role()");
    expect(migration).toContain("private.enforce_service_role()");
    expect(migration).toContain(
      "Attendance takers may edit member names but cannot archive or remove members",
    );
    expect(migration).toContain(
      'create policy "Admins delete people in their organization"',
    );
    expect(migration).toContain(
      'create policy "Admins delete services in their organization"',
    );
    expect(migration).toContain("private.protect_last_admin()");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).not.toMatch(/insert into public\.organizations/i);
  });

  it("keeps privileged user operations behind a verified admin endpoint", () => {
    expect(adminRoute).toContain("authorizeAdministrator(request)");
    expect(adminRoute).not.toContain("NEXT_PUBLIC_SUPABASE_SERVICE");
  });

  it("uses bounded exponential synchronization retry", () => {
    expect([0, 1, 2, 3, 10].map(syncRetryDelay)).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      60_000,
    ]);
  });
});
