"use client";

import type { ChurchService, Person, ServiceVisitor } from "@/lib/domain";
import type { MonthlyAttendanceDataset } from "@/lib/exports/monthly-attendance-data";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";

const CHECKMARK = "✓";
const encoder = new TextEncoder();

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function littleEndian(size: number, values: Array<[number, number, 2 | 4]>) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  for (const [offset, value, width] of values) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
  }
  return bytes;
}

function concatenate(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function zipDateParts(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createStoredZip(files: Record<string, string>, generatedAt: Date) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const dos = zipDateParts(generatedAt);
  let localOffset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const localHeader = littleEndian(30, [
      [0, 0x04034b50, 4],
      [4, 20, 2],
      [6, 0x0800, 2],
      [8, 0, 2],
      [10, dos.time, 2],
      [12, dos.date, 2],
      [14, checksum, 4],
      [18, data.length, 4],
      [22, data.length, 4],
      [26, nameBytes.length, 2],
      [28, 0, 2],
    ]);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = littleEndian(46, [
      [0, 0x02014b50, 4],
      [4, 20, 2],
      [6, 20, 2],
      [8, 0x0800, 2],
      [10, 0, 2],
      [12, dos.time, 2],
      [14, dos.date, 2],
      [16, checksum, 4],
      [20, data.length, 4],
      [24, data.length, 4],
      [28, nameBytes.length, 2],
      [30, 0, 2],
      [32, 0, 2],
      [34, 0, 2],
      [36, 0, 2],
      [38, 0, 4],
      [42, localOffset, 4],
    ]);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + data.length;
  }
  const centralDirectory = concatenate(centralParts);
  const end = littleEndian(22, [
    [0, 0x06054b50, 4],
    [4, 0, 2],
    [6, 0, 2],
    [8, centralParts.length / 2, 2],
    [10, centralParts.length / 2, 2],
    [12, centralDirectory.length, 4],
    [16, localOffset, 4],
    [20, 0, 2],
  ]);
  return concatenate([...localParts, centralDirectory, end]);
}

export interface MonthlyWorkbookLayout {
  title: string;
  finalColumn: string;
  finalRow: number;
  memberStartRow: number;
  memberEndRow: number;
  separatorRow: number;
  visitorHeaderRow: number;
  visitorStartRow: number;
  visitorEndRow: number;
  unnamedVisitorsRow: number;
  sundaySchoolKidsRow: number;
  totalAttendanceRow: number;
}

interface WorkbookCell {
  value?: string | number;
  style: number;
  formula?: string;
  cachedValue?: number;
}

function xml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function excelColumnName(columnNumber: number) {
  if (!Number.isInteger(columnNumber) || columnNumber < 1) {
    throw new Error("Excel columns start at 1.");
  }
  let value = columnNumber;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function displayName(person: Pick<Person | ServiceVisitor, "firstName" | "lastName">) {
  return person.lastName
    ? `${person.lastName}, ${person.firstName}`
    : person.firstName;
}

function servicePeriod(service: ChurchService) {
  if (service.serviceTime) {
    return Number(service.serviceTime.slice(0, 2)) < 12 ? "AM" : "PM";
  }
  if (/morning/i.test(service.serviceType)) return "AM";
  if (/evening|wednesday/i.test(service.serviceType)) return "PM";
  return "Service";
}

function utcDate(date: string) {
  return new Date(`${date}T12:00:00Z`);
}

export function formatAttendanceDateRangeTitle(
  startDate: string,
  endDate: string,
) {
  const start = utcDate(startDate);
  const end = utcDate(endDate);
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const sameYear = startYear === endYear;
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  const month = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      month: "long",
      timeZone: "UTC",
    }).format(date);
  if (startDate === endDate) {
    return `${month(start)} ${start.getUTCDate()}, ${startYear}`;
  }
  if (sameMonth) {
    return `${month(start)} ${start.getUTCDate()}–${end.getUTCDate()}, ${startYear}`;
  }
  if (sameYear) {
    return `${month(start)} ${start.getUTCDate()}–${month(end)} ${end.getUTCDate()}, ${startYear}`;
  }
  return `${month(start)} ${start.getUTCDate()}, ${startYear}–${month(end)} ${end.getUTCDate()}, ${endYear}`;
}

function serviceHeadings(
  services: ChurchService[],
  dateRange?: MonthlyAttendanceDataset["dateRange"],
) {
  const counts = new Map<string, number>();
  for (const service of services) {
    counts.set(service.serviceDate, (counts.get(service.serviceDate) ?? 0) + 1);
  }
  const periodSequence = new Map<string, number>();
  const periodTotals = new Map<string, number>();
  for (const service of services) {
    const key = `${service.serviceDate}:${servicePeriod(service)}`;
    periodTotals.set(key, (periodTotals.get(key) ?? 0) + 1);
  }
  return services.map((service) => {
    const date = utcDate(service.serviceDate);
    const dateLabel = new Intl.DateTimeFormat("en-CA", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
    if (dateRange) {
      const crossesMonths =
        dateRange.startDate.slice(0, 7) !== dateRange.endDate.slice(0, 7);
      const crossesYears =
        dateRange.startDate.slice(0, 4) !== dateRange.endDate.slice(0, 4);
      const customDateLabel = crossesMonths
        ? dateLabel
        : String(date.getUTCDate());
      const yearLabel = crossesYears ? ` ${date.getUTCFullYear()}` : "";
      const period = servicePeriod(service);
      const key = `${service.serviceDate}:${period}`;
      const sequence = (periodSequence.get(key) ?? 0) + 1;
      periodSequence.set(key, sequence);
      const duplicates = periodTotals.get(key) ?? 0;
      const serviceLabel = service.customName?.trim() || service.serviceType;
      return `${customDateLabel}${yearLabel}\n${period}${
        duplicates > 1
          ? `\n${serviceLabel} ${sequence}`
          : ""
      }`;
    }
    if ((counts.get(service.serviceDate) ?? 0) < 2) return dateLabel;
    const period = servicePeriod(service);
    const key = `${service.serviceDate}:${period}`;
    const sequence = (periodSequence.get(key) ?? 0) + 1;
    periodSequence.set(key, sequence);
    return `${dateLabel}\n${period}${
      (periodTotals.get(key) ?? 0) > 1 ? ` ${sequence}` : ""
    }`;
  });
}

function inlineCell(reference: string, cell: WorkbookCell) {
  if (cell.formula) {
    return `<c r="${reference}" s="${cell.style}"><f>${xml(
      cell.formula,
    )}</f><v>${cell.cachedValue ?? 0}</v></c>`;
  }
  if (typeof cell.value === "number") {
    return `<c r="${reference}" s="${cell.style}" t="n"><v>${cell.value}</v></c>`;
  }
  if (cell.value === undefined || cell.value === "") {
    return `<c r="${reference}" s="${cell.style}"/>`;
  }
  return `<c r="${reference}" s="${cell.style}" t="inlineStr"><is><t xml:space="preserve">${xml(
    cell.value,
  )}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: WorkbookCell[], height = 20) {
  return `<row r="${rowNumber}" ht="${height}" customHeight="1">${cells
    .map((cell, index) =>
      inlineCell(`${excelColumnName(index + 1)}${rowNumber}`, cell),
    )
    .join("")}</row>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="15"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/><family val="2"/></font>
    <font><b/><sz val="10"/><color rgb="FF1C2925"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="12"/><color rgb="FF275D43"/><name val="Segoe UI Symbol"/><family val="2"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2E5D50"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE4EFEA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF4EAD7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEDF1EF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FF7D8D86"/></left>
      <right style="thin"><color rgb="FF7D8D86"/></right>
      <top style="thin"><color rgb="FF7D8D86"/></top>
      <bottom style="thin"><color rgb="FF7D8D86"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="9">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="5" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

export function monthlyWorkbookLayout(
  dataset: MonthlyAttendanceDataset,
): MonthlyWorkbookLayout {
  const memberStartRow = 3;
  const memberEndRow = memberStartRow + dataset.members.length - 1;
  const separatorRow = memberEndRow + 1;
  const visitorHeaderRow = separatorRow + 1;
  const visitorStartRow = visitorHeaderRow + 1;
  const visitorEndRow = visitorStartRow + dataset.visitors.length - 1;
  const unnamedVisitorsRow = visitorEndRow + 1;
  const sundaySchoolKidsRow = unnamedVisitorsRow + 1;
  const totalAttendanceRow = sundaySchoolKidsRow + 1;
  const monthName = new Intl.DateTimeFormat("en-CA", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(dataset.year, dataset.month - 1, 1)));
  const periodTitle = dataset.dateRange
    ? formatAttendanceDateRangeTitle(
        dataset.dateRange.startDate,
        dataset.dateRange.endDate,
      )
    : `${monthName} ${dataset.year}`;
  return {
    title: `Abundant Life Attendance - ${periodTitle}`,
    finalColumn: excelColumnName(dataset.services.length + 1),
    finalRow: totalAttendanceRow,
    memberStartRow,
    memberEndRow,
    separatorRow,
    visitorHeaderRow,
    visitorStartRow,
    visitorEndRow,
    unnamedVisitorsRow,
    sundaySchoolKidsRow,
    totalAttendanceRow,
  };
}

export function buildMonthlyAttendanceWorkbook(
  dataset: MonthlyAttendanceDataset,
  generatedAt = new Date(),
) {
  if (dataset.services.length === 0) {
    throw new Error(
      `No services were found for the selected ${dataset.dateRange ? "date range" : "month"}.`,
    );
  }
  const services = [...dataset.services].sort(
    (left, right) =>
      left.serviceDate.localeCompare(right.serviceDate) ||
      (left.serviceTime ?? "23:59").localeCompare(
        right.serviceTime ?? "23:59",
      ) ||
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.id.localeCompare(right.id),
  );
  const layout = monthlyWorkbookLayout(dataset);
  const columnCount = services.length + 1;
  const blankRow = (style: number) =>
    Array.from({ length: columnCount }, () => ({ style }));
  const rows: string[] = [];
  rows.push(
    rowXml(
      1,
      Array.from({ length: columnCount }, (_, index) => ({
        style: 1,
        value: index === 0 ? layout.title : undefined,
      })),
      28,
    ),
  );
  const headings = serviceHeadings(services, dataset.dateRange);
  rows.push(
    rowXml(
      2,
      [
        { style: 2, value: "Members" },
        ...headings.map((heading) => ({ style: 2, value: heading })),
      ],
      dataset.dateRange && headings.some((heading) => heading.split("\n").length > 2)
        ? 52
        : 36,
    ),
  );

  const present = new Set(
    dataset.attendance
      .filter((record) => record.present)
      .map((record) => `${record.serviceId}:${record.personId}`),
  );
  for (const [memberIndex, member] of dataset.members.entries()) {
    rows.push(
      rowXml(layout.memberStartRow + memberIndex, [
        { style: 3, value: displayName(member) },
        ...services.map((service) => ({
          style: 4,
          value: present.has(`${service.id}:${member.id}`)
            ? CHECKMARK
            : undefined,
        })),
      ]),
    );
  }

  rows.push(rowXml(layout.separatorRow, blankRow(8), 10));
  rows.push(
    rowXml(
      layout.visitorHeaderRow,
      [
        { style: 5, value: "Visitors" },
        ...Array.from({ length: services.length }, () => ({ style: 5 })),
      ],
      22,
    ),
  );
  for (const [visitorIndex, visitor] of dataset.visitors.entries()) {
    rows.push(
      rowXml(layout.visitorStartRow + visitorIndex, [
        { style: 3, value: displayName(visitor) },
        ...services.map((service) => ({
          style: 4,
          value: visitor.serviceId === service.id ? CHECKMARK : undefined,
        })),
      ]),
    );
  }

  rows.push(
    rowXml(layout.unnamedVisitorsRow, [
      { style: 6, value: "Unnamed Visitors" },
      ...services.map((service) => ({
        style: 7,
        value: Math.max(0, Math.trunc(service.unnamedVisitorCount ?? 0)),
      })),
    ]),
  );
  rows.push(
    rowXml(layout.sundaySchoolKidsRow, [
      { style: 6, value: "Sunday School Kids" },
      ...services.map((service) => ({
        style: 7,
        value: Math.max(0, Math.trunc(service.sundaySchoolKidsCount ?? 0)),
      })),
    ]),
  );

  const totalCells: WorkbookCell[] = [{ style: 6, value: "Total Attendance" }];
  for (const [serviceIndex, service] of services.entries()) {
    const column = excelColumnName(serviceIndex + 2);
    const terms: string[] = [];
    if (dataset.members.length > 0) {
      terms.push(
        `COUNTIF(${column}${layout.memberStartRow}:${column}${layout.memberEndRow},"${CHECKMARK}")`,
      );
    }
    if (dataset.visitors.length > 0) {
      terms.push(
        `COUNTIF(${column}${layout.visitorStartRow}:${column}${layout.visitorEndRow},"${CHECKMARK}")`,
      );
    }
    terms.push(
      `${column}${layout.unnamedVisitorsRow}`,
      `${column}${layout.sundaySchoolKidsRow}`,
    );
    const summary = summarizeServiceAttendance(
      service,
      dataset.attendance,
      dataset.visitors,
    );
    totalCells.push({
      style: 7,
      formula: terms.join("+"),
      cachedValue: summary.totalPresent,
    });
  }
  rows.push(rowXml(layout.totalAttendanceRow, totalCells, 22));

  const columns = [
    '<col min="1" max="1" width="30" customWidth="1"/>',
    `<col min="2" max="${columnCount}" width="10.5" customWidth="1"/>`,
  ].join("");
  const generationDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(generatedAt);
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:${layout.finalColumn}${layout.finalRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="B3" sqref="B3"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>${columns}</cols>
  <sheetData>${rows.join("")}</sheetData>
  <mergeCells count="1"><mergeCell ref="A1:${layout.finalColumn}1"/></mergeCells>
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup paperSize="1" orientation="landscape" fitToWidth="1" fitToHeight="0" horizontalDpi="300" verticalDpi="300"/>
  <headerFooter><oddFooter>&amp;8Generated ${xml(generationDate)}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
  const printRange = `'Monthly Attendance'!$A$1:$${layout.finalColumn}$${layout.finalRow}`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="Church Attendance"/>
  <workbookPr date1904="0"/>
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
  <sheets><sheet name="Monthly Attendance" sheetId="1" r:id="rId1"/></sheets>
  <definedNames>
    <definedName name="_xlnm.Print_Titles" localSheetId="0">'Monthly Attendance'!$1:$2</definedName>
    <definedName name="_xlnm.Print_Area" localSheetId="0">${printRange}</definedName>
  </definedNames>
  <calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
  const created = generatedAt.toISOString();
  const files: Record<string, string> = {
    "[Content_Types].xml": contentTypesXml(),
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Church Attendance</dc:creator><cp:lastModifiedBy>Church Attendance</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Church Attendance</Application><AppVersion>1.0</AppVersion></Properties>`,
    "xl/workbook.xml": workbookXml,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": stylesXml(),
    "xl/worksheets/sheet1.xml": sheetXml,
  };
  return createStoredZip(files, generatedAt);
}

export function monthlyAttendanceFilename(year: number, month: number) {
  return `ALUPC_Attendance_${year}-${String(month).padStart(2, "0")}.xlsx`;
}

export function customAttendanceRangeFilename(
  startDate: string,
  endDate: string,
) {
  return `ALUPC_Attendance_${startDate}_to_${endDate}.xlsx`;
}

export const LARGE_RANGE_SERVICE_WARNING_THRESHOLD = 31;

export function needsLargeAttendanceRangeWarning(serviceCount: number) {
  return serviceCount > LARGE_RANGE_SERVICE_WARNING_THRESHOLD;
}

export function downloadMonthlyAttendanceWorkbook(
  workbook: Uint8Array,
  filename: string,
) {
  const blob = new Blob([workbook.slice().buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
