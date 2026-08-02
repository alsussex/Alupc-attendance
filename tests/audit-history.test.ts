import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAuditExport,
  listAuditEntries,
} from "@/lib/audit/audit-repository";
import type { Profile, UserContext } from "@/lib/domain";
import {
  addServiceVisitor,
  editServiceVisitor,
  markMemberInactive,
  removeServiceVisitor,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
  setUnnamedVisitorCount,
} from "@/lib/repositories/attendance-repository";
import {
  getOrganizationSettings,
  saveOrganizationSettings,
} from "@/lib/repositories/settings-repository";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";

const organizationId = "20000000-0000-4000-8000-000000000190";
const otherOrganizationId = "20000000-0000-4000-8000-000000000191";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000190",
  organizationId,
  email: "leader@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000191",
  email: "volunteer@example.test",
  role: "attendance_taker",
};

async function putProfile(user: UserContext, displayName: string) {
  const now = "2026-07-29T18:00:00.000Z";
  const profile: Profile = {
    id: user.userId,
    organizationId: user.organizationId,
    displayName,
    role: user.role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  await (await getDatabase()).put("profiles", profile);
}

beforeEach(async () => {
  await clearLocalDatabase();
  await putProfile(admin, "Fictional Leader");
  await putProfile(taker, "Fictional Volunteer");
});

describe("meaningful audit recording", () => {
  it("records service creation and completion with the actor snapshot", async () => {
    const service = await saveService(admin, {
      serviceDate: "2026-07-29",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    await saveService(admin, { ...service, status: "completed" });

    const entries = await listAuditEntries(admin, {
      relatedEntityId: service.id,
    });
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["completed", "created"]),
    );
    expect(entries.find((entry) => entry.action === "completed")).toMatchObject({
      userId: admin.userId,
      userDisplayName: "Fictional Leader",
      role: "admin",
    });
  });

  it("records attendance, member lifecycle, visitors, and unnamed counts", async () => {
    const member = await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Special Service",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, member.id, true);
    await setMemberAttendance(admin, service.id, member.id, false);
    await markMemberInactive(admin, member.id);
    await restoreMember(admin, member.id);
    const { visitor } = await addServiceVisitor(admin, service.id, {
      firstName: "Morgan",
      lastName: "Lane",
      notes: "First visit",
      saveAsMember: false,
    });
    await editServiceVisitor(admin, visitor.id, {
      firstName: "Morgan",
      lastName: "Lane",
      notes: "Returning",
    });
    await removeServiceVisitor(admin, visitor.id);
    await setUnnamedVisitorCount(admin, service.id, 3);

    const entries = await listAuditEntries(admin, { limit: 100 });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "marked_present",
        "marked_absent",
        "deactivated",
        "reactivated",
        "added",
        "edited",
        "removed",
        "unnamed_count_changed",
      ]),
    );
    expect(
      entries.find((entry) => entry.action === "unnamed_count_changed")
        ?.details,
    ).toMatchObject({ from: 0, to: 3, serviceId: service.id });
  });

  it("records only meaningful settings changes by settings category", async () => {
    const current = await getOrganizationSettings(organizationId);
    await saveOrganizationSettings(admin, {
      ...current.settings,
      attendanceSort: "last_name",
      visitorLabel: "Guest",
    });
    const actions = (await listAuditEntries(admin, { entityType: "settings" }))
      .map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "attendance_settings_changed",
        "visitor_settings_changed",
      ]),
    );
  });

  it("does not duplicate an audit entry for a no-op repository save", async () => {
    const member = await saveMember(admin, {
      firstName: "Cameron",
      lastName: "Vale",
    });
    await saveMember(admin, {
      id: member.id,
      firstName: "Cameron",
      lastName: "Vale",
    });
    expect(
      await listAuditEntries(admin, {
        entityType: "member",
        entityId: member.id,
      }),
    ).toHaveLength(1);
  });

  it("filters audit reports by the selected user", async () => {
    await saveMember(admin, { firstName: "Admin", lastName: "Entry" });
    await saveMember(taker, { firstName: "Volunteer", lastName: "Entry" });

    const entries = await listAuditEntries(admin, { userId: taker.userId });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: taker.userId,
      userDisplayName: "Fictional Volunteer",
    });
  });
});

describe("offline, security, and export behavior", () => {
  it("persists audit entries through restart and uploads them once", async () => {
    await saveMember(taker, { firstName: "Jordan", lastName: "West" });
    const auditMutation = (await getPendingChanges(organizationId, true)).find(
      (item) => item.table === "audit_log",
    );
    expect(auditMutation).toBeDefined();
    await closeLocalDatabaseConnection();
    expect(
      (await getPendingChanges(organizationId, true)).some(
        (item) => item.id === auditMutation?.id,
      ),
    ).toBe(true);

    const uploaded = new Map<string, Record<string, unknown>>();
    const target: UploadTarget = {
      async upsert(table, payload, _onConflict, context) {
        uploaded.set(`${table}:${context?.recordId}`, payload);
        return { version: 1, updatedAt: new Date().toISOString() };
      },
    };
    await uploadPendingChanges(organizationId, target);
    expect(uploaded.has(`audit_log:${auditMutation?.recordId}`)).toBe(true);
    expect(await getPendingChanges(organizationId, true)).toHaveLength(0);
  });

  it("downloads organization audit history through incremental reconciliation", async () => {
    const auditId = "90000000-0000-4000-8000-000000000190";
    const source: PullSource = {
      async fetchPage(table) {
        return {
          hasMore: false,
          rows:
            table === "audit_log"
              ? [
                  {
                    id: auditId,
                    organization_id: organizationId,
                    entity_type: "service",
                    entity_id: "40000000-0000-4000-8000-000000000190",
                    action: "completed",
                    user_id: admin.userId,
                    user_display_name: "Fictional Leader",
                    role: "admin",
                    occurred_at: "2026-07-29T19:00:00.000Z",
                    details: { name: "Evening Gathering" },
                    created_at: "2026-07-29T19:00:00.000Z",
                    updated_at: "2026-07-29T19:00:00.000Z",
                  },
                ]
              : [],
        };
      },
    };
    await pullOrganizationData(admin, source, { tables: ["audit_log"] });
    expect((await listAuditEntries(admin))[0]).toMatchObject({
      id: auditId,
      action: "completed",
    });
  });

  it("allows Admin history, rejects Attendance Takers, and isolates organizations", async () => {
    await saveMember(admin, { firstName: "Taylor", lastName: "Reed" });
    await saveMember(
      { ...admin, organizationId: otherOrganizationId },
      { firstName: "Casey", lastName: "North" },
    );
    expect((await listAuditEntries(admin))[0].details).toMatchObject({
      name: "Taylor Reed",
    });
    await expect(listAuditEntries(taker)).rejects.toThrow("Administrator");
  });

  it("exports required CSV and JSON fields without credentials", async () => {
    await saveMember(admin, { firstName: "Riley", lastName: "Green" });
    const csv = await buildAuditExport(admin, "csv");
    const json = await buildAuditExport(admin, "json");
    expect(csv).toContain('"Timestamp UTC","User","Role","Action","Entity Type","Entity ID","Device ID","Details"');
    expect(json).toContain('"userDisplayName": "Fictional Leader"');
    expect(`${csv}${json}`).not.toMatch(
      /access_token|refresh_token|service_role|password/i,
    );
  });

  it("uses append-only Admin-scoped RLS and exposes history in the required screens", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/202607290011_append_only_audit_log.sql"),
      "utf8",
    );
    const service = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const people = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    const settings = readFileSync(
      resolve("components/settings/SettingsCenter.tsx"),
      "utf8",
    );
    const users = readFileSync(
      resolve("app/api/admin/users/route.ts"),
      "utf8",
    );
    expect(migration).toContain("Audit history is append-only");
    expect(migration).toContain("private.enforce_audit_log_insert()");
    expect(migration).toContain("new.user_id := actor.id");
    expect(migration).toContain("audit_log_role_action_check");
    expect(migration).not.toMatch(/audit_log for update to authenticated/i);
    expect(migration).not.toMatch(/audit_log for delete to authenticated/i);
    expect(migration).toContain("and private.is_admin()");
    expect(migration).toContain(
      "organization_id = public.current_organization_id()",
    );
    expect(service).toContain('relatedEntityId={active.id}');
    expect(people).toContain('relatedEntityId={person.id}');
    expect(settings).toContain('{ id: "audit", label: "Audit History"');
    expect(users).toContain('"role_changed"');
    expect(users).toContain('"disabled"');
    expect(users).toContain('"restored"');
  });

  it("repairs the compound audit-history index on existing devices", () => {
    const databaseSource = readFileSync(
      resolve("lib/storage/database.ts"),
      "utf8",
    );
    expect(databaseSource).toContain(
      'openDB<AttendanceDatabase>("church-attendance", 7',
    );
    expect(databaseSource).toContain("if (oldVersion < 7)");
    expect(databaseSource).toContain(
      'indexNames.contains("organizationOccurredAtId")',
    );
    expect(databaseSource).toContain(
      '["organizationId", "occurredAt", "id"]',
    );
  });
});
