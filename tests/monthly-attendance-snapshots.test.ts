import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import type {
  AttendanceRecord,
  ChurchService,
  Person,
  ServiceVisitor,
  UserContext,
} from "@/lib/domain";
import type { MonthlyAttendanceDataset } from "@/lib/exports/monthly-attendance-data";
import { buildMonthlyAttendanceWorkbook } from "@/lib/exports/monthly-attendance-workbook";
import {
  buildMonthlySnapshotPayload,
  finalizeMonthlySnapshot,
  fromSnapshotCloudRecord,
  listMonthlySnapshots,
  snapshotToAttendanceDataset,
  type SnapshotSource,
} from "@/lib/reports/monthly-snapshots";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";

const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000501",
  organizationId: "20000000-0000-4000-8000-000000000501",
  email: "admin@example.test",
  role: "admin",
};
const taker: UserContext = { ...admin, userId: "10000000-0000-4000-8000-000000000502", email: "taker@example.test", role: "attendance_taker" };
const stamp = "2026-08-31T22:00:00.000Z";

function service(id: string, options: Partial<ChurchService> = {}): ChurchService {
  return {
    id,
    organizationId: admin.organizationId,
    serviceDate: "2026-08-02",
    serviceType: "Sunday Morning",
    serviceTime: "10:30",
    status: "completed",
    unnamedVisitorCount: 1,
    sundaySchoolKidsCount: 2,
    isArchived: false,
    createdBy: admin.userId,
    updatedBy: admin.userId,
    createdAt: stamp,
    updatedAt: stamp,
    ...options,
  };
}

function member(): Person {
  return {
    id: "30000000-0000-4000-8000-000000000501",
    organizationId: admin.organizationId,
    firstName: "Historical",
    lastName: "Member",
    displayName: "Historical Member",
    personType: "member",
    isActive: false,
    createdBy: admin.userId,
    updatedBy: admin.userId,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function dataset(): MonthlyAttendanceDataset {
  const historical = member();
  const services = [
    service("40000000-0000-4000-8000-000000000501", { isArchived: true }),
    service("40000000-0000-4000-8000-000000000502", { serviceDate: "2026-08-03", deletedAt: stamp }),
    service("40000000-0000-4000-8000-000000000503", { serviceDate: "2026-08-04", status: "draft" }),
  ];
  const attendance: AttendanceRecord[] = [{
    id: "50000000-0000-4000-8000-000000000501",
    organizationId: admin.organizationId,
    serviceId: services[0].id,
    personId: historical.id,
    present: true,
    createdBy: admin.userId,
    updatedBy: admin.userId,
    createdAt: stamp,
    updatedAt: stamp,
  }];
  const visitors: ServiceVisitor[] = [{
    id: "60000000-0000-4000-8000-000000000501",
    organizationId: admin.organizationId,
    serviceId: services[0].id,
    firstName: "FirstNameOnly",
    lastName: "",
    displayName: "FirstNameOnly",
    savedAsMember: false,
    createdBy: admin.userId,
    updatedBy: admin.userId,
    createdAt: stamp,
    updatedAt: stamp,
  }];
  return { monthKey: "2026-08", year: 2026, month: 8, services, members: [historical], attendance, visitors };
}

function cloudRecord(overrides: Record<string, unknown> = {}) {
  const payload = buildMonthlySnapshotPayload(dataset(), "Abundant Life UPC");
  return {
    id: "70000000-0000-4000-8000-000000000501",
    organization_id: admin.organizationId,
    month_start: "2026-08-01",
    snapshot_version: 1,
    status: "finalized",
    payload,
    notes: null,
    service_count: payload.services.length,
    total_attendance: payload.services.reduce((total, row) => total + row.totalAttendance, 0),
    finalized_by: admin.userId,
    finalized_by_name: "Fictional Administrator",
    finalized_at: stamp,
    created_at: stamp,
    ...overrides,
  };
}

function source(options: { existing?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const value: SnapshotSource & { inserted: Record<string, unknown>[] } = {
    inserted,
    list: vi.fn(async () => [cloudRecord()]),
    find: vi.fn(async () => options.existing ? cloudRecord() : undefined),
    organizationName: vi.fn(async () => "Abundant Life UPC"),
    insert: vi.fn(async (record) => {
      inserted.push(record);
      return record;
    }),
  };
  return value;
}

beforeEach(async () => {
  await clearLocalDatabase();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  const database = await getDatabase();
  await database.put("profiles", {
    id: admin.userId,
    organizationId: admin.organizationId,
    displayName: "Fictional Administrator",
    role: "admin",
    isActive: true,
    createdAt: stamp,
    updatedAt: stamp,
  });
});

describe("monthly attendance snapshot integrity", () => {
  it("builds a display-ready preview with archived services and without deleted or open services", () => {
    const payload = buildMonthlySnapshotPayload(dataset(), "Abundant Life UPC");
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toMatchObject({
      id: "40000000-0000-4000-8000-000000000501",
      unnamedVisitors: 1,
      sundaySchoolKids: 2,
      totalAttendance: 5,
    });
    expect(payload.members[0]).toMatchObject({
      displayName: "Historical Member",
      attendedServiceIds: ["40000000-0000-4000-8000-000000000501"],
    });
  });

  it("preserves historical names independently of later member edits", () => {
    const data = dataset();
    const payload = buildMonthlySnapshotPayload(data, "Abundant Life UPC");
    data.members[0].displayName = "Renamed Later";
    data.members[0].firstName = "Renamed";
    expect(payload.members[0].displayName).toBe("Historical Member");
    expect(payload.members[0].firstName).toBe("Historical");
  });

  it("finalizes from a fresh authoritative completed-service load and records audit history", async () => {
    const store = source();
    const load = vi.fn(async () => dataset());
    const snapshot = await finalizeMonthlySnapshot(admin, 2026, 8, "Office copy", store, load);
    expect(load).toHaveBeenCalledWith(admin, 2026, 8, true);
    expect(store.inserted).toHaveLength(1);
    expect(snapshot).toMatchObject({
      organizationId: admin.organizationId,
      monthStart: "2026-08-01",
      serviceCount: 1,
      totalAttendance: 5,
      finalizedByName: "Fictional Administrator",
    });
    expect(await listAuditEntries(admin, { entityType: "report_snapshot" })).toEqual([
      expect.objectContaining({ action: "finalized", entityId: snapshot.id }),
    ]);
  });

  it("blocks duplicate months before inserting or replacing anything", async () => {
    const store = source({ existing: true });
    const load = vi.fn(async () => dataset());
    await expect(finalizeMonthlySnapshot(admin, 2026, 8, "", store, load)).rejects.toThrow(
      "already exists",
    );
    expect(load).not.toHaveBeenCalled();
    expect(store.inserted).toHaveLength(0);
  });

  it("requires authoritative online data and propagates pending-change failures", async () => {
    const store = source();
    const load = vi.fn(async () => {
      throw new Error("2 unsynced changes affect this export. Sync all pending changes before exporting attendance, then try again.");
    });
    await expect(finalizeMonthlySnapshot(admin, 2026, 8, "", store, load)).rejects.toThrow(
      "unsynced changes",
    );
    expect(store.inserted).toHaveLength(0);

    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    await expect(finalizeMonthlySnapshot(admin, 2026, 8, "", store, vi.fn())).rejects.toThrow(
      "internet connection",
    );
  });

  it("allows Attendance Takers to read but never finalize snapshots", async () => {
    const store = source();
    expect(await listMonthlySnapshots(taker, store)).toHaveLength(1);
    await expect(finalizeMonthlySnapshot(taker, 2026, 8, "", store, vi.fn())).rejects.toThrow(
      "Administrator",
    );
    expect(store.inserted).toHaveLength(0);
  });

  it("rejects cross-organization snapshot records", () => {
    expect(() =>
      fromSnapshotCloudRecord(
        cloudRecord({ organization_id: "20000000-0000-4000-8000-000000000999" }),
        admin.organizationId,
      ),
    ).toThrow("another organization");
  });

  it("reproduces the finalized snapshot as the existing printable Excel workbook", () => {
    const record = cloudRecord();
    const payload = record.payload as ReturnType<typeof buildMonthlySnapshotPayload>;
    payload.services[0].heading = "Stored Official Heading";
    const snapshot = fromSnapshotCloudRecord(record, admin.organizationId);
    const restored = snapshotToAttendanceDataset(snapshot);
    const workbook = buildMonthlyAttendanceWorkbook(restored, new Date(stamp));
    const contents = new TextDecoder().decode(workbook);
    expect(contents).toContain("Member, Historical");
    expect(contents).toContain("FirstNameOnly");
    expect(contents).toContain("Sunday School Kids");
    expect(contents).toContain("Stored Official Heading");
    expect(contents).toContain("Abundant Life UPC Attendance - August 2026");
  });
});

describe("monthly snapshot migration security", () => {
  const migration = readFileSync(
    resolve("supabase/migrations/202608020001_monthly_attendance_snapshots.sql"),
    "utf8",
  );

  it("enforces organization-scoped read access and Admin-only inserts", () => {
    expect(migration).toContain("Organization users read finalized monthly snapshots");
    expect(migration).toContain("organization_id = public.current_organization_id()");
    expect(migration).toContain("private.is_admin()");
    expect(migration).toContain("finalized_by = auth.uid()");
  });

  it("makes finalized rows immutable and unique per organization month", () => {
    expect(migration).toContain("monthly_attendance_snapshots_one_month_unique");
    expect(migration).toContain("monthly_snapshot_reject_update");
    expect(migration).toContain("monthly_snapshot_reject_delete");
    expect(migration).not.toContain("for update to authenticated");
    expect(migration).not.toContain("for delete to authenticated");
  });
});
