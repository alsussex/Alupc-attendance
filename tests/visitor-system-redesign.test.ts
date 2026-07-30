import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  addServiceVisitor,
  adjustUnnamedVisitorCount,
  getServiceAttendance,
  listServiceVisitors,
  listServices,
  removeServiceVisitor,
  saveMember,
  saveService,
  setMemberAttendance,
  setUnnamedVisitorCount,
} from "@/lib/repositories/attendance-repository";
import { buildAttendanceReportRows } from "@/lib/reports/attendance-report";
import { buildOrganizationExport } from "@/lib/settings/exports";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";

const organizationId = "20000000-0000-4000-8000-000000000160";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000160",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

async function serviceSummary(serviceId: string) {
  const database = await getDatabase();
  const service = await database.get("services", serviceId);
  if (!service) throw new Error("Test service not found.");
  return summarizeServiceAttendance(
    service,
    await getServiceAttendance(serviceId),
    await listServiceVisitors(serviceId),
  );
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("unified visitor attendance totals", () => {
  it("updates the single visitor and total-present counts for named additions and removals", async () => {
    const member = await saveMember(user, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const service = await saveService(user, {
      serviceDate: "2026-11-01",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(user, service.id, member.id, true);
    const { visitor } = await addServiceVisitor(user, service.id, {
      firstName: "Morgan",
      lastName: "Lane",
      saveAsMember: false,
    });

    expect(await serviceSummary(service.id)).toMatchObject({
      membersPresent: 1,
      namedVisitorCount: 1,
      unnamedVisitorCount: 0,
      visitorTotal: 1,
      totalPresent: 2,
    });

    await removeServiceVisitor(user, visitor.id);
    expect(await serviceSummary(service.id)).toMatchObject({
      membersPresent: 1,
      namedVisitorCount: 0,
      visitorTotal: 0,
      totalPresent: 1,
    });
  });

  it("increments and decrements unnamed visitors immediately without going negative", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-11-08",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    await adjustUnnamedVisitorCount(user, service.id, 1);
    await adjustUnnamedVisitorCount(user, service.id, 1);
    expect(await serviceSummary(service.id)).toMatchObject({
      unnamedVisitorCount: 2,
      visitorTotal: 2,
      totalPresent: 2,
    });

    await adjustUnnamedVisitorCount(user, service.id, -1);
    await adjustUnnamedVisitorCount(user, service.id, -8);
    expect(await serviceSummary(service.id)).toMatchObject({
      unnamedVisitorCount: 0,
      visitorTotal: 0,
      totalPresent: 0,
    });
  });

  it("combines named and unnamed visitors once without creating fake records", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-11-15",
      serviceType: "Special Service",
      status: "draft",
    });
    await addServiceVisitor(user, service.id, {
      firstName: "Jordan",
      lastName: "West",
      saveAsMember: false,
    });
    await setUnnamedVisitorCount(user, service.id, 2);

    expect(await serviceSummary(service.id)).toMatchObject({
      namedVisitorCount: 1,
      unnamedVisitorCount: 2,
      visitorTotal: 3,
      totalPresent: 3,
    });
    expect(await listServiceVisitors(service.id)).toHaveLength(1);
  });

  it("does not double-count a named visitor converted to a permanent member", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-11-22",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await addServiceVisitor(user, service.id, {
      firstName: "Taylor",
      lastName: "Reed",
      saveAsMember: true,
    });

    expect(await serviceSummary(service.id)).toMatchObject({
      membersPresent: 1,
      namedVisitorCount: 0,
      visitorTotal: 0,
      totalPresent: 1,
    });
  });
});

describe("visitor durability, synchronization, and history", () => {
  it("persists offline count changes across restart and keeps one service mutation", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-11-29",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await (await getDatabase()).clear("syncQueue");
    await Promise.all([
      adjustUnnamedVisitorCount(user, service.id, 1),
      adjustUnnamedVisitorCount(user, service.id, 1),
      adjustUnnamedVisitorCount(user, service.id, 1),
    ]);
    await closeLocalDatabaseConnection();

    expect((await listServices(organizationId))[0]).toMatchObject({
      id: service.id,
      unnamedVisitorCount: 3,
    });
    const pending = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "services" && item.recordId === service.id,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ unnamed_visitor_count: 3 });
  });

  it("preserves completed-service member, visitor, and total history", async () => {
    const member = await saveMember(user, {
      firstName: "Riley",
      lastName: "Harbor",
    });
    const service = await saveService(user, {
      serviceDate: "2026-12-06",
      serviceType: "Sunday Morning",
      status: "draft",
      unnamedVisitorCount: 2,
    });
    await setMemberAttendance(user, service.id, member.id, true);
    await addServiceVisitor(user, service.id, {
      firstName: "Casey",
      lastName: "North",
      saveAsMember: false,
    });
    await saveService(user, {
      ...service,
      unnamedVisitorCount: 2,
      status: "completed",
    });
    await closeLocalDatabaseConnection();

    expect((await listServices(organizationId))[0].status).toBe("completed");
    expect(await serviceSummary(service.id)).toMatchObject({
      membersPresent: 1,
      namedVisitorCount: 1,
      unnamedVisitorCount: 2,
      visitorTotal: 3,
      totalPresent: 4,
    });
  });
});

describe("visitor reporting and exports", () => {
  it("builds accurate historical report totals for completed services", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-12-12",
      serviceType: "Special Service",
      customName: "Community Service",
      status: "draft",
      unnamedVisitorCount: 2,
    });
    await addServiceVisitor(user, service.id, {
      firstName: "Jamie",
      lastName: "River",
      saveAsMember: false,
    });
    await saveService(user, {
      ...service,
      unnamedVisitorCount: 2,
      status: "completed",
    });
    const database = await getDatabase();
    const rows = buildAttendanceReportRows(
      await database.getAllFromIndex(
        "services",
        "organizationId",
        organizationId,
      ),
      await database.getAllFromIndex(
        "attendance",
        "organizationId",
        organizationId,
      ),
      await database.getAllFromIndex(
        "visitors",
        "organizationId",
        organizationId,
      ),
    );

    expect(rows).toContainEqual(
      expect.objectContaining({
        serviceId: service.id,
        serviceName: "Community Service",
        status: "completed",
        membersPresent: 0,
        namedVisitorCount: 1,
        unnamedVisitorCount: 2,
        visitorTotal: 3,
        totalPresent: 3,
      }),
    );
  });

  it("exports detailed visitor fields in service CSV and complete JSON backup", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-12-13",
      serviceType: "Sunday Evening",
      status: "draft",
      unnamedVisitorCount: 2,
    });
    await addServiceVisitor(user, service.id, {
      firstName: "Quinn",
      lastName: "Parker",
      saveAsMember: false,
    });
    await saveService(user, {
      ...service,
      unnamedVisitorCount: 2,
      status: "completed",
    });

    const csv = await buildOrganizationExport(user, "services");
    for (const field of [
      "members_present",
      "named_visitor_count",
      "unnamed_visitor_count",
      "visitor_total",
      "total_present",
    ]) {
      expect(csv).toContain(`"${field}"`);
    }
    expect(csv).toContain('"0","1","2","3","3"');

    const backup = JSON.parse(
      await buildOrganizationExport(user, "backup"),
    ) as {
      serviceAttendanceSummaries: Array<Record<string, unknown>>;
      visitors: Array<Record<string, unknown>>;
    };
    expect(backup.serviceAttendanceSummaries).toContainEqual({
      service_id: service.id,
      members_present: 0,
      named_visitor_count: 1,
      unnamed_visitor_count: 2,
      visitor_total: 3,
      total_present: 3,
    });
    expect(backup.visitors).toHaveLength(1);
  });

  it("keeps the primary UI summary unified while retaining the unnamed stepper", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const summaryStart = source.indexOf(
      'className="attendance-metrics"',
    );
    const summaryEnd = source.indexOf(
      "{actionFeedback &&",
      summaryStart,
    );
    const summary = source.slice(summaryStart, summaryEnd);
    expect(summary.indexOf("Members Present")).toBeLessThan(
      summary.indexOf("Visitors"),
    );
    expect(summary.indexOf("Visitors")).toBeLessThan(
      summary.indexOf("Total Present"),
    );
    expect(summary.match(/<span>Visitors<\/span>/g)).toHaveLength(1);
    expect(source).toContain('aria-label="Unnamed visitor count"');
    expect(source).not.toContain(
      "{namedVisitorCount} named + {active.unnamedVisitorCount",
    );
  });
});
