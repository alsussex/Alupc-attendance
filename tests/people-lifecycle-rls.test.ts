import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  getServiceAttendance,
  listActiveMembers,
  listMembers,
  markMemberInactive,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";

const organizationId = "20000000-0000-4000-8000-000000000050";
const administrator: UserContext = {
  userId: "10000000-0000-4000-8000-000000000050",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const attendanceTaker: UserContext = {
  userId: "10000000-0000-4000-8000-000000000051",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

class RepairablePolicyTarget implements UploadTarget {
  rejectPeople = false;
  rows = new Map<string, Record<string, unknown>>();

  async upsert(
    table: "people" | "services" | "service_attendance" | "service_visitors",
    payload: Record<string, unknown>,
  ) {
    if (table === "people" && this.rejectPeople) {
      throw new Error(
        'new row violates row-level security policy for table "people"',
      );
    }
    this.rows.set(`${table}:${String(payload.id)}`, payload);
  }
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("people lifecycle behavior", () => {
  it("lets an Admin deactivate, edit, and reactivate the same member", async () => {
    const member = await saveMember(administrator, {
      firstName: "Avery",
      lastName: "Stone",
    });
    await markMemberInactive(administrator, member.id);
    const edited = await saveMember(administrator, {
      id: member.id,
      firstName: "Avery",
      lastName: "River",
    });
    expect(edited).toMatchObject({
      id: member.id,
      displayName: "Avery River",
      isActive: false,
    });

    const reactivated = await restoreMember(administrator, member.id);
    expect(reactivated).toMatchObject({ id: member.id, isActive: true });
    expect(await listMembers(organizationId)).toHaveLength(1);
    expect((await listActiveMembers(organizationId))[0].id).toBe(member.id);
  });

  it("keeps Attendance Takers on ordinary member edits only", async () => {
    const member = await saveMember(attendanceTaker, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    const edited = await saveMember(attendanceTaker, {
      id: member.id,
      firstName: "Morgan",
      lastName: "Field",
    });
    expect(edited.displayName).toBe("Morgan Field");

    await expect(
      markMemberInactive(attendanceTaker, member.id),
    ).rejects.toThrow("administrator");
    await markMemberInactive(administrator, member.id);
    await expect(restoreMember(attendanceTaker, member.id)).rejects.toThrow(
      "administrator",
    );
  });

  it("retries the failed inactive mutation without changing identity or history", async () => {
    const member = await saveMember(administrator, {
      firstName: "Jordan",
      lastName: "West",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-07-27",
      serviceType: "Sunday Morning",
      status: "completed",
    });
    await setMemberAttendance(administrator, service.id, member.id, true);
    const target = new RepairablePolicyTarget();
    await uploadPendingChanges(organizationId, target);

    await markMemberInactive(administrator, member.id);
    target.rejectPeople = true;
    const failed = await uploadPendingChanges(organizationId, target);
    expect(failed.errors[0]).toContain("row-level security policy");
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      table: "people",
      recordId: member.id,
      status: "error",
    });

    target.rejectPeople = false;
    const retried = await uploadPendingChanges(organizationId, target);
    expect(retried.uploaded).toBe(1);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect(target.rows.get(`people:${member.id}`)).toMatchObject({
      id: member.id,
      is_active: false,
    });
    expect(await listMembers(organizationId)).toHaveLength(1);
    expect((await listMembers(organizationId))[0].id).toBe(member.id);
    expect(await getServiceAttendance(service.id)).toHaveLength(1);
    expect((await getServiceAttendance(service.id))[0]).toMatchObject({
      personId: member.id,
      present: true,
    });
  });
});

describe("corrective people RLS migration", () => {
  const migration = readFileSync(
    resolve("supabase/migrations/202607290005_fix_people_lifecycle_rls.sql"),
    "utf8",
  );
  const selectPolicy = migration.slice(
    migration.indexOf('create policy "Users read people in their organization"'),
    migration.indexOf(
      'create policy "Admins add or upsert members in their organization"',
    ),
  );
  const adminUpdatePolicy = migration.slice(
    migration.indexOf(
      'create policy "Admins update people in their organization"',
    ),
    migration.indexOf(
      'create policy "Attendance takers update ordinary member fields"',
    ),
  );

  it("replaces the faulty generic insert and update policies exactly once", () => {
    expect(migration).toContain(
      'drop policy if exists "Users add members in their organization"',
    );
    expect(migration).toContain(
      'drop policy if exists "Users update people in their organization"',
    );
    expect(
      migration.match(
        /create policy "Admins update people in their organization"/g,
      ),
    ).toHaveLength(1);
    expect(
      migration.match(
        /create policy "Attendance takers update ordinary member fields"/g,
      ),
    ).toHaveLength(1);
  });

  it("lets authorized organization users select active and inactive records", () => {
    expect(selectPolicy).toContain(
      "organization_id = public.current_organization_id()",
    );
    expect(selectPolicy).toContain(
      "private.current_profile_role() in ('admin', 'attendance_taker')",
    );
    expect(selectPolicy).not.toMatch(/\bis_active\b/);
    expect(selectPolicy).not.toContain("inactive_at");
    expect(selectPolicy).not.toContain("deleted_at");
  });

  it("gives Admin updates organization-scoped USING and WITH CHECK rules", () => {
    expect(adminUpdatePolicy.match(/private\.is_admin\(\)/g)).toHaveLength(2);
    expect(
      adminUpdatePolicy.match(
        /organization_id = public\.current_organization_id\(\)/g,
      ),
    ).toHaveLength(2);
    expect(adminUpdatePolicy).toContain("updated_by = auth.uid()");
    expect(adminUpdatePolicy).toContain(
      "(not is_active or inactive_at is null)",
    );
    expect(adminUpdatePolicy).not.toContain("and is_active\n");
  });

  it("supports inactive upserts without allowing Attendance Taker lifecycle changes", () => {
    expect(migration).toContain(
      "private.people_record_exists_in_organization(id, organization_id)",
    );
    expect(migration).toContain(
      "private.current_profile_role() = 'attendance_taker'",
    );
    expect(migration).toContain(
      "new.is_active is distinct from old.is_active",
    );
    expect(migration).toContain(
      "new.inactive_at is distinct from old.inactive_at",
    );
    expect(migration).toContain(
      "new.deleted_at is distinct from old.deleted_at",
    );
  });

  it("prevents cross-organization and ownership changes without recursive RLS", () => {
    expect(migration).toContain(
      "new.organization_id is distinct from old.organization_id",
    );
    expect(migration).toContain(
      "new.created_by is distinct from old.created_by",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).not.toContain("disable row level security");
    expect(migration).not.toContain("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY");
  });
});
