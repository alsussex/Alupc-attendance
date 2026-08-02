import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChurchService, UserContext } from "@/lib/domain";
import {
  adjustSundaySchoolKidsCount,
  adjustUnnamedVisitorCount,
  listServices,
  saveMember,
  saveService,
  setMemberAttendance,
  setSundaySchoolKidsCount,
} from "@/lib/repositories/attendance-repository";
import { buildAttendanceReportRows } from "@/lib/reports/attendance-report";
import { attendancePresentCounts } from "@/lib/services/attendance-view";
import { childProgramForService } from "@/lib/services/child-program";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";
import { buildOrganizationExport } from "@/lib/settings/exports";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord, toCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000820";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000820",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("Sunday School Kids attendance counter", () => {
  it("increments independently from unnamed visitors and never becomes negative", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await adjustUnnamedVisitorCount(user, service.id, 2);
    await adjustSundaySchoolKidsCount(user, service.id, 3);
    await adjustSundaySchoolKidsCount(user, service.id, -1);

    expect((await listServices(organizationId))[0]).toMatchObject({
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 2,
    });
    expect(
      (await (await getDatabase()).getAll("auditLog")).some(
        (entry) =>
          entry.action === "sunday_school_kids_count_changed" &&
          entry.details?.name === "Sunday School Kids",
      ),
    ).toBe(true);

    await adjustSundaySchoolKidsCount(user, service.id, -20);
    expect((await listServices(organizationId))[0]).toMatchObject({
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 0,
    });
  });

  it("counts kids toward total attendance without changing the visitor subtotal", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Morning",
      status: "draft",
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 4,
    });
    const member = await saveMember(user, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    await setMemberAttendance(user, service.id, member.id, true);
    const summary = summarizeServiceAttendance(
      service,
      await (await getDatabase()).getAll("attendance"),
      [],
    );
    expect(summary).toMatchObject({
      membersPresent: 1,
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 4,
      visitorTotal: 2,
      totalPresent: 7,
    });
    expect(attendancePresentCounts(new Set([member.id]), [], true, 2, 4)).toEqual({
      total: 7,
      members: 1,
      visitors: 2,
    });
  });

  it("persists offline, queues one versioned service update, and survives restart", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-16",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await (await getDatabase()).clear("syncQueue");
    await Promise.all([
      adjustSundaySchoolKidsCount(user, service.id, 1),
      adjustSundaySchoolKidsCount(user, service.id, 1),
      adjustSundaySchoolKidsCount(user, service.id, 1),
    ]);
    await closeLocalDatabaseConnection();

    expect((await listServices(organizationId))[0]).toMatchObject({
      id: service.id,
      sundaySchoolKidsCount: 3,
    });
    const mutations = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "services" && item.recordId === service.id,
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0].payload).toMatchObject({
      sunday_school_kids_count: 3,
    });
  });

  it("round-trips through cloud serialization and defaults old records to zero", () => {
    const baseCloud = {
      id: "40000000-0000-4000-8000-000000000820",
      organization_id: organizationId,
      service_date: "2026-08-23",
      service_type: "Sunday Morning",
      status: "draft",
      unnamed_visitor_count: 1,
      is_archived: false,
      version: 2,
      created_by: user.userId,
      updated_by: user.userId,
      created_at: "2026-08-23T12:00:00.000Z",
      updated_at: "2026-08-23T12:00:00.000Z",
    };
    expect(fromCloudRecord("services", baseCloud)).toMatchObject({
      sundaySchoolKidsCount: 0,
    });
    const local = fromCloudRecord("services", {
      ...baseCloud,
      sunday_school_kids_count: 5,
    });
    expect(local).toMatchObject({ sundaySchoolKidsCount: 5 });
    expect(toCloudRecord(local)).toMatchObject({
      sunday_school_kids_count: 5,
    });
  });

  it("locks the count on completion and restores editing after an Admin reopens", async () => {
    const draft = await saveService(user, {
      serviceDate: "2026-08-30",
      serviceType: "Sunday Morning",
      status: "draft",
      sundaySchoolKidsCount: 2,
    });
    const completed = await saveService(user, {
      ...draft,
      status: "completed",
    });
    await expect(
      setSundaySchoolKidsCount(user, completed.id, 3),
    ).rejects.toThrow("completed and locked");
    const reopened = await saveService(user, {
      ...completed,
      status: "draft",
    });
    expect((await adjustSundaySchoolKidsCount(user, reopened.id, 1)).sundaySchoolKidsCount).toBe(3);
  });

  it("includes the independent count in reports, exports, backups, and totals", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-09-06",
      serviceType: "Sunday Morning",
      status: "draft",
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 4,
    });
    const database = await getDatabase();
    const reports = buildAttendanceReportRows(
      [service],
      await database.getAll("attendance"),
      await database.getAll("visitors"),
    );
    expect(reports[0]).toMatchObject({
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 4,
      visitorTotal: 2,
      totalPresent: 6,
    });
    const csv = await buildOrganizationExport(user, "services");
    expect(csv).toContain('"sunday_school_kids_count"');
    expect(csv).toContain('"0","0","2","4","2","6"');
    const backup = JSON.parse(
      await buildOrganizationExport(user, "backup"),
    ) as { services: ChurchService[]; serviceAttendanceSummaries: Array<Record<string, unknown>> };
    expect(backup.services[0].sundaySchoolKidsCount).toBe(4);
    expect(backup.serviceAttendanceSummaries[0]).toMatchObject({
      sunday_school_kids_count: 4,
      total_present: 6,
    });
  });

  it("uses service-specific labels while retaining one shared counter", () => {
    expect(childProgramForService("Sunday Morning")).toEqual({
      label: "Sunday School Kids",
      helperText: "Children attending Sunday School without recorded names.",
    });
    expect(childProgramForService("Wednesday Bible Study")).toEqual({
      label: "Children’s Church",
      helperText:
        "Children attending Children’s Church without recorded names.",
    });
    expect(childProgramForService("Sunday Evening")).toBeNull();
    expect(childProgramForService("Special Service")).toEqual({
      label: "Sunday School Kids",
      helperText: "Children attending Sunday School without recorded names.",
    });
    expect(childProgramForService("Other")).toBeNull();

    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    expect(source).toContain("childProgramForService(active?.serviceType)");
    expect(source).toContain(
      'className="unnamed-visitor-counter sunday-school-kids-counter"',
    );
    expect(source).toContain("childProgram.label");
    expect(source).toContain("childProgram.helperText");
    const css = readFileSync(resolve("app/globals.css"), "utf8");
    expect(css).toContain(".sunday-school-kids-counter");
    expect(css).toContain(".unnamed-visitor-counter { margin: .7rem;");
  });

  it("adds a backward-compatible constrained database column without changing RLS", () => {
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607300007_sunday_school_kids_count.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(
      "add column if not exists sunday_school_kids_count integer not null default 0",
    );
    expect(migration).toContain("sunday_school_kids_count >= 0");
    expect(migration).not.toMatch(/disable row level security|create policy/i);
  });
});
