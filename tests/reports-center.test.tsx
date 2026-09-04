import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsCenter } from "@/components/reports/ReportsCenter";
import type {
  AttendanceRecord,
  ChurchService,
  Person,
  ServiceVisitor,
} from "@/lib/domain";
import {
  completedServiceReportRows,
  memberAttendanceReport,
  reportCsv,
  reportDashboard,
  reportStatistics,
  visitorReportRows,
  yearlyReport,
  type ReportsDataset,
} from "@/lib/reports/report-center";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import {
  assertReportSectionAccess,
  canAccessReportSection,
} from "@/lib/reports/permissions";

let role: "admin" | "attendance_taker" = "admin";

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: "admin-1",
      organizationId: "org-1",
      email: "admin@example.test",
      role,
    },
  }),
}));

vi.mock("@/components/audit/AuditHistory", () => ({
  AuditHistory: () => <div>Audit report filters</div>,
}));

const stamp = "2026-08-02T12:00:00.000Z";

function service(
  id: string,
  date: string,
  type: string,
  options: Partial<ChurchService> = {},
): ChurchService {
  return {
    id,
    organizationId: "org-1",
    serviceDate: date,
    serviceType: type,
    status: "completed",
    isArchived: false,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: stamp,
    updatedAt: stamp,
    ...options,
  };
}

function person(id: string, name: string, active = true): Person {
  const [firstName, ...last] = name.split(" ");
  return {
    id,
    organizationId: "org-1",
    firstName,
    lastName: last.join(" "),
    displayName: name,
    personType: "member",
    isActive: active,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: stamp,
  };
}

function present(id: string, serviceId: string, personId: string): AttendanceRecord {
  return {
    id,
    organizationId: "org-1",
    serviceId,
    personId,
    present: true,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function visitor(
  id: string,
  serviceId: string,
  name: string,
  visitorPersonId?: string,
): ServiceVisitor {
  const [firstName, ...last] = name.split(" ");
  return {
    id,
    organizationId: "org-1",
    serviceId,
    visitorPersonId,
    firstName,
    lastName: last.join(" "),
    displayName: name,
    savedAsMember: false,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function dataset(): ReportsDataset {
  const services = [
    service("sun-am", "2026-08-02", "Sunday Morning", {
      serviceTime: "10:30",
      unnamedVisitorCount: 1,
      sundaySchoolKidsCount: 2,
    }),
    service("sun-pm", "2026-08-02", "Sunday Evening", {
      serviceTime: "18:30",
    }),
    service("wed", "2026-08-05", "Wednesday Bible Study", {
      serviceTime: "19:00",
      isArchived: true,
    }),
    service("deleted", "2026-08-09", "Sunday Morning", {
      deletedAt: stamp,
    }),
  ];
  const people = [person("member-1", "Alex Member"), person("member-2", "Inactive Member", false)];
  const attendance = [
    present("a1", "sun-am", "member-1"),
    present("a2", "sun-pm", "member-1"),
    present("a3", "wed", "member-2"),
  ];
  const visitors = [
    visitor("v1", "sun-am", "Jordan Guest", "returning-jordan"),
    visitor("v2", "sun-pm", "Jordan Guest", "returning-jordan"),
  ];
  return { people, services, attendance, visitors };
}

describe("professional reports calculations", () => {
  it("builds dashboard and yearly totals from completed non-deleted services", () => {
    const data = dataset();
    const dashboard = reportDashboard(data, new Date("2026-08-10T12:00:00Z"));
    expect(dashboard).toMatchObject({
      activeMembers: 1,
      archivedMembers: 1,
      servicesThisMonth: 3,
      visitorsThisMonth: 3,
      sundaySchoolKidsThisMonth: 2,
      averageSundayMorning: 5,
      averageSundayEvening: 2,
      averageWednesday: 1,
    });
    expect(yearlyReport(data, 2026)).toMatchObject({
      servicesHeld: 3,
      totalVisitors: 3,
      totalSundaySchoolKids: 2,
      highestAttendance: 5,
    });
  });

  it("keeps archived service history and excludes deleted services", () => {
    expect(completedServiceReportRows(dataset()).map((row) => row.service.id)).toEqual([
      "wed",
      "sun-pm",
      "sun-am",
    ]);
  });

  it("calculates member attendance, visitor visits, and useful records", () => {
    const data = dataset();
    expect(memberAttendanceReport(data, "member-1")).toMatchObject({
      present: 2,
      absent: 1,
      percentage: 67,
      firstAttendance: "2026-08-02",
      lastAttendance: "2026-08-02",
    });
    expect(visitorReportRows(data)).toEqual([
      expect.objectContaining({ name: "Jordan Guest", visits: 2 }),
    ]);
    expect(reportStatistics(data, new Date("2026-08-10T12:00:00Z"))).toMatchObject({
      averageThisYear: 3,
      averageAllTime: 3,
    });
  });

  it("does not combine unlinked people merely because their names match", () => {
    const data = dataset();
    data.visitors = [
      visitor("unlinked-1", "sun-am", "Taylor Guest"),
      visitor("unlinked-2", "sun-pm", "Taylor Guest"),
    ];
    expect(visitorReportRows(data)).toEqual([
      expect.objectContaining({ name: "Taylor Guest", visits: 1 }),
      expect.objectContaining({ name: "Taylor Guest", visits: 1 }),
    ]);
  });

  it("creates a spreadsheet-safe CSV export", () => {
    expect(reportCsv(["Name", "Notes"], [["Jordan", 'Said "hello"']])).toBe(
      '"Name","Notes"\r\n"Jordan","Said ""hello"""',
    );
  });
});

describe("ReportsCenter", () => {
  beforeEach(async () => {
    role = "admin";
    window.location.hash = "";
    await clearLocalDatabase();
    const database = await getDatabase();
    const data = dataset();
    await database.put("organizations", {
      id: "org-1",
      name: "Abundant Life UPC",
      slug: "alupc",
      createdAt: stamp,
      updatedAt: stamp,
    });
    await Promise.all([
      ...data.people.map((row) => database.put("people", row)),
      ...data.services.map((row) => database.put("services", row)),
      ...data.attendance.map((row) => database.put("attendance", row)),
      ...data.visitors.map((row) => database.put("visitors", row)),
    ]);
  });

  afterEach(() => cleanup());

  it("renders accessible report navigation and switches office reports", async () => {
    render(<ReportsCenter />);
    expect(await screen.findByRole("heading", { name: "Attendance dashboard" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Report categories" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Service History/ }));
    expect(screen.getByRole("heading", { name: "Service history" })).toBeVisible();
    expect(screen.getByText("Wednesday Bible Study")).toBeVisible();
    expect(screen.queryByText("deleted")).toBeNull();
  });

  it("offers monthly, custom range, member, visitor, yearly, statistics, and Admin audit reports", async () => {
    render(<ReportsCenter />);
    await waitFor(() => expect(screen.queryByLabelText("Loading reports")).toBeNull());
    const reportNavigation = within(
      screen.getByRole("navigation", { name: "Report categories" }),
    );
    for (const name of [
      "Monthly Attendance",
      "Custom Date Range",
      "Member Attendance",
      "Visitor Report",
      "Monthly Attendance Snapshots",
      "Yearly Summary",
      "Statistics",
      "Audit Reports",
    ]) {
      expect(reportNavigation.getByText(name, { selector: "strong" })).toBeVisible();
    }
  });

  it("does not expose audit reports to Attendance Takers", async () => {
    role = "attendance_taker";
    render(<ReportsCenter />);
    await screen.findByRole("heading", { name: "Monthly attendance" });
    const reportNavigation = within(
      screen.getByRole("navigation", { name: "Report categories" }),
    );
    for (const permitted of [
      "Monthly Attendance",
      "Custom Date Range",
      "Service History",
      "Member Attendance",
      "Visitor Report",
      "Monthly Attendance Snapshots",
    ]) {
      expect(reportNavigation.getByText(permitted, { selector: "strong" })).toBeVisible();
    }
    for (const restricted of [
      "Dashboard",
      "Yearly Summary",
      "Statistics",
      "Audit Reports",
    ]) {
      expect(reportNavigation.queryByText(restricted, { selector: "strong" })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /Audit Reports/ })).toBeNull();
    expect(screen.queryByRole("option", { name: "Audit Reports" })).toBeNull();
  });

  it("enforces Admin report access in the data-access permission layer", () => {
    expect(canAccessReportSection("attendance_taker", "monthly")).toBe(true);
    expect(canAccessReportSection("attendance_taker", "snapshots")).toBe(true);
    expect(canAccessReportSection("attendance_taker", "dashboard")).toBe(false);
    expect(() =>
      assertReportSectionAccess(
        {
          userId: "taker-1",
          organizationId: "org-1",
          email: "taker@example.test",
          role: "attendance_taker",
        },
        "statistics",
      ),
    ).toThrow("Administrator");
  });
});

describe("report table viewport", () => {
  const reportSource = readFileSync(
    resolve("components/reports/AttendanceExportReport.tsx"),
    "utf8",
  );
  const snapshotSource = readFileSync(
    resolve("components/reports/MonthlySnapshotsReport.tsx"),
    "utf8",
  );
  const styles = readFileSync(resolve("app/product-system.css"), "utf8");

  it("uses the shared spreadsheet viewport for monthly, range, and snapshot attendance", () => {
    expect(reportSource).toContain(
      'className="report-table-scroll attendance-sheet-scroll"',
    );
    expect(snapshotSource).toContain(
      'className="report-table-scroll attendance-sheet-scroll"',
    );
    expect(reportSource).toContain('className="attendance-sheet-table"');
    expect(snapshotSource).toContain('className="attendance-sheet-table"');
  });

  it("contains every report table and freezes attendance labels while columns scroll", () => {
    expect(styles).toContain("overscroll-behavior-inline: contain");
    expect(styles).toContain(".report-data-table {\n  width: max-content;");
    expect(styles).toContain(
      ".attendance-report-preview .attendance-sheet-table tr > :first-child",
    );
    expect(styles).toContain("position: sticky");
    expect(styles).toContain(".attendance-export-report > .report-primary-actions");
    expect(styles).toContain("justify-content: flex-start");
  });
});
