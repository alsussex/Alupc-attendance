import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AttendanceRecord,
  ChurchService,
  Person,
  ServiceVisitor,
  UserContext,
} from "@/lib/domain";
import {
  attendanceDateRange,
  ensureCustomAttendanceRangeCache,
  ensureMonthlyAttendanceCache,
  isCustomAttendanceRangeCacheComplete,
  isMonthlyAttendanceCacheComplete,
  loadCustomAttendanceRangeDataset,
  loadMonthlyAttendanceDataset,
  type MonthlyAttendanceDataset,
  type MonthlyAttendanceSource,
} from "@/lib/exports/monthly-attendance-data";
import {
  attendanceServiceColumns,
  buildMonthlyAttendanceWorkbook,
  customAttendanceRangeFilename,
  excelColumnName,
  formatAttendanceDateRangeTitle,
  monthlyAttendanceFilename,
  monthlyWorkbookLayout,
  needsLargeAttendanceRangeWarning,
} from "@/lib/exports/monthly-attendance-workbook";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { toCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000120";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000120",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const createdAt = "2026-08-01T10:00:00.000Z";

function unzipStoredWorkbook(workbook: Uint8Array) {
  const view = new DataView(
    workbook.buffer,
    workbook.byteOffset,
    workbook.byteLength,
  );
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= workbook.byteLength) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (compressionMethod !== 0) {
      throw new Error("The workbook test reader expects stored ZIP entries.");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(workbook.subarray(nameStart, nameStart + nameLength));
    files.set(
      name,
      decoder.decode(workbook.subarray(dataStart, dataStart + compressedSize)),
    );
    offset = dataStart + compressedSize;
  }
  return files;
}

function service(
  id: string,
  date: string,
  time = "10:30",
  overrides: Partial<ChurchService> = {},
): ChurchService {
  return {
    id,
    organizationId,
    serviceDate: date,
    serviceType: "Sunday Morning",
    serviceTime: time,
    status: "completed",
    unnamedVisitorCount: 0,
    sundaySchoolKidsCount: 0,
    isArchived: false,
    createdBy: user.userId,
    updatedBy: user.userId,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function member(
  id: string,
  firstName: string,
  lastName: string,
  overrides: Partial<Person> = {},
): Person {
  return {
    id,
    organizationId,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
    personType: "member",
    isActive: true,
    createdBy: user.userId,
    updatedBy: user.userId,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function attendance(
  id: string,
  serviceId: string,
  personId: string,
  present = true,
): AttendanceRecord {
  return {
    id,
    organizationId,
    serviceId,
    personId,
    present,
    createdBy: user.userId,
    updatedBy: user.userId,
    createdAt,
    updatedAt: createdAt,
  };
}

function visitor(
  id: string,
  serviceId: string,
  firstName: string,
  lastName = "",
): ServiceVisitor {
  return {
    id,
    organizationId,
    serviceId,
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
    savedAsMember: false,
    createdBy: user.userId,
    updatedBy: user.userId,
    createdAt,
    updatedAt: createdAt,
  };
}

function dataset(
  overrides: Partial<MonthlyAttendanceDataset> = {},
): MonthlyAttendanceDataset {
  return {
    monthKey: "2026-08",
    year: 2026,
    month: 8,
    services: [service("service-one", "2026-08-02")],
    members: [member("member-one", "Avery", "Stone")],
    attendance: [attendance("attendance-one", "service-one", "member-one")],
    visitors: [],
    ...overrides,
  };
}

function workbookXml(data: MonthlyAttendanceDataset) {
  const files = unzipStoredWorkbook(
    buildMonthlyAttendanceWorkbook(data, new Date("2026-09-01T12:00:00Z")),
  );
  return {
    sheet: files.get("xl/worksheets/sheet1.xml") ?? "",
    workbook: files.get("xl/workbook.xml") ?? "",
    styles: files.get("xl/styles.xml") ?? "",
    fileNames: [...files.keys()],
  };
}

function cellText(sheetXml: string, reference: string) {
  const document = new DOMParser().parseFromString(sheetXml, "application/xml");
  const cell = [...document.getElementsByTagName("c")].find(
    (entry) => entry.getAttribute("r") === reference,
  );
  return cell?.textContent ?? "";
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("monthly attendance workbook", () => {
  it("exposes month, year, and service-status export controls", () => {
    const source = readFileSync(
      resolve("components/settings/MonthlyAttendanceExport.tsx"),
      "utf8",
    );

    expect(source).toContain("Export Attendance");
    expect(source).toContain("Completed services only");
    expect(source).toContain("Include open services");
    expect(source).toContain("Preparing workbook…");
  });

  it("creates one print-ready worksheet for a single service", () => {
    const output = workbookXml(dataset());

    expect(output.workbook).toContain('name="Monthly Attendance"');
    expect(output.workbook.match(/<sheet /g)).toHaveLength(1);
    expect(output.sheet).toContain('<mergeCell ref="A1:B1"/>');
    expect(output.sheet).toContain('xSplit="1" ySplit="2"');
    expect(output.sheet).toContain('orientation="landscape"');
    expect(output.sheet).toContain('fitToWidth="1" fitToHeight="0"');
    expect(output.workbook).toContain("'Monthly Attendance'!$1:$2");
    expect(output.sheet).toContain("Generated Sep 1, 2026");
    expect(output.styles).toContain('<borders count="2">');
  });

  it("orders multiple services chronologically and distinguishes AM and PM", () => {
    const output = workbookXml(
      dataset({
        services: [
          service("evening", "2026-08-02", "18:30", {
            serviceType: "Sunday Evening",
          }),
          service("morning", "2026-08-02", "10:30"),
          service("later", "2026-08-09", "10:30"),
        ],
      }),
    );

    expect(cellText(output.sheet, "B2")).toBe("Aug 2\nAM");
    expect(cellText(output.sheet, "C2")).toBe("Aug 2\nPM");
    expect(cellText(output.sheet, "D2")).toBe("Aug 9");
  });

  it("creates no August 1 column and keeps August 2 AM and PM as distinct service columns", () => {
    const morning = service("august-two-am", "2026-08-02", "10:30", {
      serviceType: "Sunday Morning",
      unnamedVisitorCount: 1,
      sundaySchoolKidsCount: 2,
    });
    const evening = service("august-two-pm", "2026-08-02", "18:30", {
      serviceType: "Sunday Evening",
      unnamedVisitorCount: 3,
      sundaySchoolKidsCount: 0,
    });
    const data = dataset({
      services: [evening, morning],
      members: [
        member("morning-member", "Avery", "Morning"),
        member("evening-member", "Blair", "Night"),
      ],
      attendance: [
        attendance("morning-present", morning.id, "morning-member", true),
        attendance("evening-present", evening.id, "evening-member", true),
      ],
      visitors: [
        visitor("morning-visitor", morning.id, "Mina", "Day"),
        visitor("evening-visitor", evening.id, "Nora", "Night"),
      ],
    });
    const columns = attendanceServiceColumns(data);
    const layout = monthlyWorkbookLayout(data);
    const output = workbookXml(data);

    expect(columns.map((column) => column.service.id)).toEqual([
      "august-two-am",
      "august-two-pm",
    ]);
    expect(layout.finalColumn).toBe("C");
    expect(cellText(output.sheet, "B2")).toBe("Aug 2\nAM");
    expect(cellText(output.sheet, "C2")).toBe("Aug 2\nPM");
    expect(output.sheet).not.toContain("Aug 1");
    expect(cellText(output.sheet, "B3")).toBe("✓");
    expect(cellText(output.sheet, "C3")).toBe("");
    expect(cellText(output.sheet, "B4")).toBe("");
    expect(cellText(output.sheet, "C4")).toBe("✓");
    expect(cellText(output.sheet, `B${layout.visitorStartRow}`)).toBe("✓");
    expect(cellText(output.sheet, `C${layout.visitorStartRow}`)).toBe("");
    expect(cellText(output.sheet, `B${layout.visitorStartRow + 1}`)).toBe("");
    expect(cellText(output.sheet, `C${layout.visitorStartRow + 1}`)).toBe("✓");
    expect(cellText(output.sheet, `B${layout.unnamedVisitorsRow}`)).toBe("1");
    expect(cellText(output.sheet, `C${layout.unnamedVisitorsRow}`)).toBe("3");
    expect(cellText(output.sheet, `B${layout.sundaySchoolKidsRow}`)).toBe("2");
    expect(cellText(output.sheet, `C${layout.sundaySchoolKidsRow}`)).toBe("0");
    expect(cellText(output.sheet, `B${layout.totalAttendanceRow}`)).toContain("5");
    expect(cellText(output.sheet, `C${layout.totalAttendanceRow}`)).toContain("5");
  });

  it("uses custom names to distinguish same-day services in the same period", () => {
    const output = workbookXml(
      dataset({
        services: [
          service("early", "2026-08-02", "09:00", {
            serviceType: "Special Service",
            customName: "Prayer Service",
          }),
          service("late", "2026-08-02", "11:00", {
            serviceType: "Special Service",
            customName: "Family Worship",
          }),
        ],
      }),
    );

    expect(cellText(output.sheet, "B2")).toBe(
      "Aug 2\nAM\nPrayer Service 1",
    );
    expect(cellText(output.sheet, "C2")).toBe(
      "Aug 2\nAM\nFamily Worship 2",
    );
  });

  it("supports more than 26 service columns", () => {
    const services = Array.from({ length: 30 }, (_, index) =>
      service(`service-${index}`, `2026-08-${String(index + 1).padStart(2, "0")}`),
    );
    const data = dataset({ services });

    expect(excelColumnName(31)).toBe("AE");
    expect(monthlyWorkbookLayout(data).finalColumn).toBe("AE");
    expect(workbookXml(data).sheet).toContain('<mergeCell ref="A1:AE1"/>');
  });

  it("leaves absences blank and places checks only for present members", () => {
    const output = workbookXml(
      dataset({
        members: [
          member("member-one", "Avery", "Stone"),
          member("member-two", "Blair", "Young"),
        ],
        attendance: [
          attendance("a1", "service-one", "member-one", true),
          attendance("a2", "service-one", "member-two", false),
        ],
      }),
    );

    expect(cellText(output.sheet, "B3")).toBe("✓");
    expect(cellText(output.sheet, "B4")).toBe("");
    expect(output.sheet).not.toContain(">false<");
  });

  it("keeps first-name-only and same-name visitor records on separate rows", () => {
    const data = dataset({
      visitors: [
        visitor("visitor-one", "service-one", "Jordan"),
        visitor("visitor-two", "service-one", "Alex", "Smith"),
        visitor("visitor-three", "service-one", "Alex", "Smith"),
      ],
    });
    const layout = monthlyWorkbookLayout(data);
    const output = workbookXml(data);

    expect(cellText(output.sheet, `A${layout.visitorStartRow}`)).toBe("Jordan");
    expect(cellText(output.sheet, `A${layout.visitorStartRow + 1}`)).toBe(
      "Smith, Alex",
    );
    expect(cellText(output.sheet, `A${layout.visitorStartRow + 2}`)).toBe(
      "Smith, Alex",
    );
  });

  it("includes the separator, visitor counts, kids, and formula-backed total", () => {
    const currentService = service("service-one", "2026-08-02", "10:30", {
      unnamedVisitorCount: 2,
      sundaySchoolKidsCount: 3,
    });
    const data = dataset({
      services: [currentService],
      visitors: [visitor("visitor-one", "service-one", "Jordan")],
    });
    const layout = monthlyWorkbookLayout(data);
    const output = workbookXml(data);

    expect(cellText(output.sheet, `A${layout.separatorRow}`)).toBe("");
    expect(cellText(output.sheet, `A${layout.visitorHeaderRow}`)).toBe("Visitors");
    expect(cellText(output.sheet, `B${layout.unnamedVisitorsRow}`)).toBe("2");
    expect(cellText(output.sheet, `B${layout.sundaySchoolKidsRow}`)).toBe("3");
    expect(cellText(output.sheet, `B${layout.totalAttendanceRow}`)).toContain(
      "COUNTIF",
    );
    expect(cellText(output.sheet, `B${layout.totalAttendanceRow}`)).toContain("7");
  });

  it("does not expose technical IDs in visible workbook content", () => {
    const output = workbookXml(dataset());

    expect(output.sheet).not.toContain("member-one");
    expect(output.sheet).not.toContain("service-one");
    expect(output.sheet).not.toContain("organizationId");
    expect(output.fileNames).toHaveLength(8);
    expect(monthlyAttendanceFilename(2026, 8)).toBe(
      "ALUPC_Attendance_2026-08.xlsx",
    );
  });

  it("refuses to create a workbook with no services", () => {
    expect(() => buildMonthlyAttendanceWorkbook(dataset({ services: [] }))).toThrow(
      "No services",
    );
  });
});

describe("monthly cache completeness and historical data", () => {
  it("blocks an uncached offline month instead of exporting incomplete data", async () => {
    await expect(
      ensureMonthlyAttendanceCache(user, 2026, 8, { online: false }),
    ).rejects.toThrow("not been fully saved");
    expect(await isMonthlyAttendanceCacheComplete(user, 2026, 8)).toBe(false);
  });

  it("fetches only the selected month and then permits offline reuse", async () => {
    const calls: string[][] = [];
    const source: MonthlyAttendanceSource = {
      async fetchRange(_organizationId, startDate, endDate) {
        calls.push([startDate, endDate]);
        return { services: [], people: [], attendance: [], visitors: [] };
      },
    };

    await ensureMonthlyAttendanceCache(user, 2026, 8, {
      online: true,
      source,
    });
    await ensureMonthlyAttendanceCache(user, 2026, 8, { online: false });

    expect(calls).toEqual([["2026-08-01", "2026-09-01"]]);
    expect(await isMonthlyAttendanceCacheComplete(user, 2026, 8)).toBe(true);
  });

  it("refreshes a complete online month and removes stale phantom service columns", async () => {
    const phantom = service("phantom-august-one", "2026-08-01", "10:30");
    const morning = service("real-august-two-am", "2026-08-02", "10:30", {
      serviceType: "Sunday Morning",
    });
    const evening = service("real-august-two-pm", "2026-08-02", "18:30", {
      serviceType: "Sunday Evening",
    });
    const currentMember = member("refresh-member", "Robin", "Field");
    let invocation = 0;
    const source: MonthlyAttendanceSource = {
      async fetchRange() {
        invocation += 1;
        if (invocation === 1) {
          return {
            services: [toCloudRecord(phantom)],
            people: [toCloudRecord(currentMember)],
            attendance: [],
            visitors: [],
          };
        }
        return {
          services: [toCloudRecord(evening), toCloudRecord(morning)],
          people: [],
          attendance: [
            toCloudRecord(
              attendance("refresh-am", morning.id, currentMember.id, true),
            ),
          ],
          visitors: [],
        };
      },
    };

    await ensureMonthlyAttendanceCache(user, 2026, 8, {
      online: true,
      source,
    });
    expect(
      (await loadMonthlyAttendanceDataset(user, 2026, 8, true)).services.map(
        (entry) => entry.id,
      ),
    ).toEqual([phantom.id]);

    await ensureMonthlyAttendanceCache(user, 2026, 8, {
      online: true,
      source,
    });
    const refreshed = await loadMonthlyAttendanceDataset(user, 2026, 8, true);
    const output = workbookXml(refreshed);

    expect(invocation).toBe(2);
    expect(refreshed.services.map((entry) => entry.id)).toEqual([
      morning.id,
      evening.id,
    ]);
    expect(cellText(output.sheet, "B2")).toBe("Aug 2\nAM");
    expect(cellText(output.sheet, "C2")).toBe("Aug 2\nPM");
    expect(output.sheet).not.toContain("Aug 1");
    expect(cellText(output.sheet, "B3")).toBe("✓");
    expect(cellText(output.sheet, "C3")).toBe("");
  });

  it("does not mark a failed partial month as complete", async () => {
    const source: MonthlyAttendanceSource = {
      async fetchRange() {
        throw new Error("Temporary server failure");
      },
    };

    await expect(
      ensureMonthlyAttendanceCache(user, 2026, 8, {
        online: true,
        source,
      }),
    ).rejects.toThrow("no workbook was created");
    expect(await isMonthlyAttendanceCacheComplete(user, 2026, 8)).toBe(false);
  });

  it("sorts members by last name and retains inactive historical attendees", async () => {
    const database = await getDatabase();
    const archived = service("archived", "2026-08-03", "19:00", {
      isArchived: true,
    });
    const inactive = member("inactive", "Taylor", "Adams", {
      isActive: false,
      inactiveAt: "2026-08-20T00:00:00.000Z",
    });
    await Promise.all([
      database.put("services", archived),
      database.put("people", member("active", "Casey", "Brown")),
      database.put("people", inactive),
      database.put(
        "attendance",
        attendance("history", archived.id, inactive.id, true),
      ),
    ]);

    const loaded = await loadMonthlyAttendanceDataset(user, 2026, 8, true);

    expect(loaded.services[0].isArchived).toBe(true);
    expect(loaded.members.map((person) => person.id)).toEqual([
      "inactive",
      "active",
    ]);
  });

  it("filters open services only when completed-only is selected", async () => {
    const database = await getDatabase();
    await Promise.all([
      database.put("services", service("complete", "2026-08-02")),
      database.put(
        "services",
        service("draft", "2026-08-09", "10:30", { status: "draft" }),
      ),
    ]);

    expect(
      (await loadMonthlyAttendanceDataset(user, 2026, 8, true)).services,
    ).toHaveLength(1);
    expect(
      (await loadMonthlyAttendanceDataset(user, 2026, 8, false)).services,
    ).toHaveLength(2);
  });
});

describe("custom attendance date range export", () => {
  it("validates inclusive ranges and rejects reversed or invalid dates", () => {
    expect(attendanceDateRange("2026-08-03", "2026-08-23")).toMatchObject({
      startDate: "2026-08-03",
      endDate: "2026-08-23",
      endDateExclusive: "2026-08-24",
    });
    expect(() => attendanceDateRange("", "2026-08-23")).toThrow(
      "valid start date",
    );
    expect(() => attendanceDateRange("2026-08-24", "2026-08-23")).toThrow(
      "cannot be earlier",
    );
    expect(() => attendanceDateRange("2026-02-30", "2026-03-01")).toThrow(
      "valid start date",
    );
  });

  it("formats same-month, cross-month, and cross-year titles", () => {
    expect(
      formatAttendanceDateRangeTitle("2026-08-03", "2026-08-23"),
    ).toBe("August 3–23, 2026");
    expect(
      formatAttendanceDateRangeTitle("2026-07-12", "2026-09-05"),
    ).toBe("July 12–September 5, 2026");
    expect(
      formatAttendanceDateRangeTitle("2026-12-20", "2027-01-10"),
    ).toBe("December 20, 2026–January 10, 2027");
  });

  it("uses compact day and AM/PM headings within one month", () => {
    const output = workbookXml(
      dataset({
        dateRange: { startDate: "2026-08-03", endDate: "2026-08-23" },
        services: [
          service("morning", "2026-08-03", "10:30"),
          service("evening", "2026-08-05", "19:00"),
        ],
      }),
    );

    expect(cellText(output.sheet, "A1")).toBe(
      "Abundant Life Attendance - August 3–23, 2026",
    );
    expect(cellText(output.sheet, "B2")).toBe("3\nAM");
    expect(cellText(output.sheet, "C2")).toBe("5\nPM");
  });

  it("adds month abbreviations across months and years", () => {
    const crossMonth = workbookXml(
      dataset({
        dateRange: { startDate: "2026-07-12", endDate: "2026-09-05" },
        services: [
          service("july", "2026-07-12", "10:30"),
          service("august", "2026-08-02", "18:00"),
          service("september", "2026-09-05", "19:00"),
        ],
      }),
    );
    expect(cellText(crossMonth.sheet, "B2")).toBe("Jul 12\nAM");
    expect(cellText(crossMonth.sheet, "C2")).toBe("Aug 2\nPM");
    expect(cellText(crossMonth.sheet, "D2")).toBe("Sep 5\nPM");

    const crossYear = workbookXml(
      dataset({
        dateRange: { startDate: "2026-12-20", endDate: "2027-01-10" },
        services: [
          service("december", "2026-12-20", "10:30"),
          service("january", "2027-01-10", "18:00"),
        ],
      }),
    );
    expect(cellText(crossYear.sheet, "B2")).toBe("Dec 20 2026\nAM");
    expect(cellText(crossYear.sheet, "C2")).toBe("Jan 10 2027\nPM");
  });

  it("keeps multiple same-day services separate and names same-period services", () => {
    const output = workbookXml(
      dataset({
        dateRange: { startDate: "2026-08-09", endDate: "2026-08-09" },
        services: [
          service("morning-one", "2026-08-09", "09:00", {
            serviceType: "Sunday School",
          }),
          service("morning-two", "2026-08-09", "11:00", {
            serviceType: "Sunday Morning",
          }),
          service("evening", "2026-08-09", "18:00", {
            serviceType: "Sunday Evening",
          }),
        ],
      }),
    );

    expect(cellText(output.sheet, "B2")).toContain("9\nAM\nSunday School 1");
    expect(cellText(output.sheet, "C2")).toContain("9\nAM\nSunday Morning 2");
    expect(cellText(output.sheet, "D2")).toBe("9\nPM");
  });

  it("loads inclusive boundaries across multiple months and includes archives", async () => {
    const database = await getDatabase();
    await Promise.all([
      database.put("services", service("before", "2026-07-11")),
      database.put("services", service("start", "2026-07-12")),
      database.put("services", service("middle", "2026-08-02")),
      database.put(
        "services",
        service("end", "2026-09-05", "19:00", { isArchived: true }),
      ),
      database.put("services", service("after", "2026-09-06")),
    ]);

    const loaded = await loadCustomAttendanceRangeDataset(
      user,
      "2026-07-12",
      "2026-09-05",
      true,
    );
    expect(loaded.services.map((entry) => entry.id)).toEqual([
      "start",
      "middle",
      "end",
    ]);
    expect(loaded.services.at(-1)?.isArchived).toBe(true);
  });

  it("targets only uncovered portions of a multi-month range", async () => {
    const calls: string[][] = [];
    const source: MonthlyAttendanceSource = {
      async fetchRange(_organizationId, startDate, endDateExclusive) {
        calls.push([startDate, endDateExclusive]);
        return { services: [], people: [], attendance: [], visitors: [] };
      },
    };
    await ensureMonthlyAttendanceCache(user, 2026, 8, {
      online: true,
      source,
    });
    await ensureCustomAttendanceRangeCache(
      user,
      "2026-07-12",
      "2026-09-05",
      { online: true, source },
    );

    expect(calls).toEqual([
      ["2026-08-01", "2026-09-01"],
      ["2026-07-12", "2026-08-01"],
      ["2026-09-01", "2026-09-06"],
    ]);
    expect(
      await isCustomAttendanceRangeCacheComplete(
        user,
        "2026-07-12",
        "2026-09-05",
      ),
    ).toBe(true);
  });

  it("blocks incomplete offline ranges and failed targeted downloads", async () => {
    await expect(
      ensureCustomAttendanceRangeCache(user, "2026-07-12", "2026-09-05", {
        online: false,
      }),
    ).rejects.toThrow("not been fully saved");
    const source: MonthlyAttendanceSource = {
      async fetchRange() {
        throw new Error("Temporary server failure");
      },
    };
    await expect(
      ensureCustomAttendanceRangeCache(user, "2026-07-12", "2026-09-05", {
        online: true,
        source,
      }),
    ).rejects.toThrow("no workbook was created");
    expect(
      await isCustomAttendanceRangeCacheComplete(
        user,
        "2026-07-12",
        "2026-09-05",
      ),
    ).toBe(false);
  });

  it("shows no-services errors, large-range warnings, and range filenames", async () => {
    await expect(
      loadCustomAttendanceRangeDataset(
        user,
        "2026-08-03",
        "2026-08-23",
        false,
      ),
    ).rejects.toThrow("No services were found for the selected date range");
    expect(needsLargeAttendanceRangeWarning(31)).toBe(false);
    expect(needsLargeAttendanceRangeWarning(32)).toBe(true);
    expect(customAttendanceRangeFilename("2026-08-03", "2026-08-23")).toBe(
      "ALUPC_Attendance_2026-08-03_to_2026-08-23.xlsx",
    );
  });

  it("exposes both export modes and remembers only the mode preference", () => {
    const source = readFileSync(
      resolve("components/settings/MonthlyAttendanceExport.tsx"),
      "utf8",
    );
    expect(source).toContain('value="monthly">Monthly');
    expect(source).toContain('value="range">Custom Date Range');
    expect(source).toContain("church-attendance-export-mode");
    expect(source).toContain("Start date");
    expect(source).toContain("End date");
    expect(source).toContain("Export anyway");
  });
});
