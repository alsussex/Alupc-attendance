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
  ensureMonthlyAttendanceCache,
  isMonthlyAttendanceCacheComplete,
  loadMonthlyAttendanceDataset,
  type MonthlyAttendanceDataset,
  type MonthlyAttendanceSource,
} from "@/lib/exports/monthly-attendance-data";
import {
  buildMonthlyAttendanceWorkbook,
  excelColumnName,
  monthlyAttendanceFilename,
  monthlyWorkbookLayout,
} from "@/lib/exports/monthly-attendance-workbook";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";

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

    expect(source).toContain("Export Monthly Attendance");
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
      async fetchMonth(_organizationId, startDate, endDate) {
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

  it("does not mark a failed partial month as complete", async () => {
    const source: MonthlyAttendanceSource = {
      async fetchMonth() {
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
