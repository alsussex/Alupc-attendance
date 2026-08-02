"use client";

import type {
  AttendanceRecord,
  ChurchService,
  Organization,
  Person,
  ServiceVisitor,
} from "@/lib/domain";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";
import { getDatabase } from "@/lib/storage/database";

export interface ReportsDataset {
  organization?: Organization;
  people: Person[];
  services: ChurchService[];
  attendance: AttendanceRecord[];
  visitors: ServiceVisitor[];
}

export interface ServiceReportRow {
  service: ChurchService;
  members: number;
  visitors: number;
  sundaySchoolKids: number;
  total: number;
}

export interface MemberReportRow {
  person: Person;
  present: number;
  absent: number;
  percentage: number;
  firstAttendance?: string;
  lastAttendance?: string;
  services: ServiceReportRow[];
}

export interface VisitorReportRow {
  key: string;
  name: string;
  visits: number;
  firstVisit: string;
  lastVisit: string;
  services: ServiceReportRow[];
}

export interface YearlyReportSummary {
  year: number;
  servicesHeld: number;
  averageSundayMorning: number;
  averageSundayEvening: number;
  averageWednesday: number;
  totalVisitors: number;
  totalSundaySchoolKids: number;
  highestAttendance: number;
  lowestAttendance: number;
  averageAttendance: number;
}

function activeService(service: ChurchService) {
  return !service.deletedAt;
}

function completedService(service: ChurchService) {
  return activeService(service) && service.status === "completed";
}

function period(service: ChurchService) {
  if (service.serviceTime) {
    return Number(service.serviceTime.slice(0, 2)) < 12 ? "am" : "pm";
  }
  return /morning/i.test(service.serviceType) ? "am" : "pm";
}

function serviceRows(dataset: ReportsDataset, services: ChurchService[]) {
  return services
    .map((service): ServiceReportRow => {
      const summary = summarizeServiceAttendance(
        service,
        dataset.attendance,
        dataset.visitors,
      );
      return {
        service,
        members: summary.membersPresent,
        visitors: summary.visitorTotal,
        sundaySchoolKids: summary.sundaySchoolKidsCount,
        total: summary.totalPresent,
      };
    })
    .sort(
      (left, right) =>
        right.service.serviceDate.localeCompare(left.service.serviceDate) ||
        (right.service.serviceTime ?? "").localeCompare(
          left.service.serviceTime ?? "",
        ),
    );
}

function average(rows: ServiceReportRow[]) {
  return rows.length
    ? Math.round(rows.reduce((total, row) => total + row.total, 0) / rows.length)
    : 0;
}

export async function loadReportsDataset(
  organizationId: string,
): Promise<ReportsDataset> {
  const database = await getDatabase();
  const [organization, people, services, attendance, visitors] =
    await Promise.all([
      database.get("organizations", organizationId),
      database.getAllFromIndex("people", "organizationId", organizationId),
      database.getAllFromIndex("services", "organizationId", organizationId),
      database.getAllFromIndex("attendance", "organizationId", organizationId),
      database.getAllFromIndex("visitors", "organizationId", organizationId),
    ]);
  return { organization, people, services, attendance, visitors };
}

export function completedServiceReportRows(dataset: ReportsDataset) {
  return serviceRows(dataset, dataset.services.filter(completedService));
}

export function reportDashboard(dataset: ReportsDataset, now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthRows = serviceRows(
    dataset,
    dataset.services.filter(
      (service) => completedService(service) && service.serviceDate.startsWith(month),
    ),
  );
  const sundayMorning = monthRows.filter(
    ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "am",
  );
  const sundayEvening = monthRows.filter(
    ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "pm",
  );
  const wednesday = monthRows.filter(({ service }) =>
    /wednesday/i.test(service.serviceType),
  );
  return {
    activeMembers: dataset.people.filter(
      (person) =>
        person.personType === "member" &&
        person.isActive &&
        !person.deletedAt &&
        !person.mergedIntoId,
    ).length,
    archivedMembers: dataset.people.filter(
      (person) =>
        person.personType === "member" &&
        !person.mergedIntoId &&
        (!person.isActive || Boolean(person.deletedAt)),
    ).length,
    servicesThisMonth: monthRows.length,
    attendanceThisMonth: monthRows.reduce((sum, row) => sum + row.total, 0),
    visitorsThisMonth: monthRows.reduce((sum, row) => sum + row.visitors, 0),
    sundaySchoolKidsThisMonth: monthRows.reduce(
      (sum, row) => sum + row.sundaySchoolKids,
      0,
    ),
    averageSundayMorning: average(sundayMorning),
    averageSundayEvening: average(sundayEvening),
    averageWednesday: average(wednesday),
  };
}

export function memberAttendanceReport(
  dataset: ReportsDataset,
  personId: string,
): MemberReportRow | undefined {
  const person = dataset.people.find(
    (item) => item.id === personId && item.personType === "member",
  );
  if (!person) return undefined;
  const eligible = completedServiceReportRows(dataset).filter(
    ({ service }) => service.serviceDate >= person.createdAt.slice(0, 10),
  );
  const presentServiceIds = new Set(
    dataset.attendance
      .filter((record) => record.personId === personId && record.present)
      .map((record) => record.serviceId),
  );
  const attended = eligible.filter(({ service }) =>
    presentServiceIds.has(service.id),
  );
  const dates = attended.map(({ service }) => service.serviceDate).sort();
  return {
    person,
    present: attended.length,
    absent: Math.max(0, eligible.length - attended.length),
    percentage: eligible.length
      ? Math.round((attended.length / eligible.length) * 100)
      : 0,
    firstAttendance: dates[0],
    lastAttendance: dates.at(-1),
    services: attended,
  };
}

function normalizedVisitorName(visitor: ServiceVisitor) {
  return `${visitor.firstName} ${visitor.lastName}`
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function visitorReportRows(
  dataset: ReportsDataset,
  startDate?: string,
  endDate?: string,
) {
  const services = completedServiceReportRows(dataset).filter(
    ({ service }) =>
      (!startDate || service.serviceDate >= startDate) &&
      (!endDate || service.serviceDate <= endDate),
  );
  const serviceById = new Map(services.map((row) => [row.service.id, row]));
  const groups = new Map<string, VisitorReportRow>();
  for (const visitor of dataset.visitors) {
    if (visitor.deletedAt || visitor.savedAsMember) continue;
    const service = serviceById.get(visitor.serviceId);
    if (!service) continue;
    const key = visitor.memberPersonId || normalizedVisitorName(visitor);
    const name = visitor.displayName.trim() || visitor.firstName.trim();
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        name,
        visits: 1,
        firstVisit: service.service.serviceDate,
        lastVisit: service.service.serviceDate,
        services: [service],
      });
    } else {
      existing.visits += 1;
      existing.firstVisit = [existing.firstVisit, service.service.serviceDate].sort()[0];
      existing.lastVisit = [existing.lastVisit, service.service.serviceDate].sort().at(-1)!;
      existing.services.push(service);
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

export function yearlyReport(dataset: ReportsDataset, year: number) {
  const rows = completedServiceReportRows(dataset).filter(({ service }) =>
    service.serviceDate.startsWith(`${year}-`),
  );
  const sundayMorning = rows.filter(
    ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "am",
  );
  const sundayEvening = rows.filter(
    ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "pm",
  );
  const wednesday = rows.filter(({ service }) =>
    /wednesday/i.test(service.serviceType),
  );
  const totals = rows.map((row) => row.total);
  return {
    year,
    servicesHeld: rows.length,
    averageSundayMorning: average(sundayMorning),
    averageSundayEvening: average(sundayEvening),
    averageWednesday: average(wednesday),
    totalVisitors: rows.reduce((sum, row) => sum + row.visitors, 0),
    totalSundaySchoolKids: rows.reduce(
      (sum, row) => sum + row.sundaySchoolKids,
      0,
    ),
    highestAttendance: totals.length ? Math.max(...totals) : 0,
    lowestAttendance: totals.length ? Math.min(...totals) : 0,
    averageAttendance: average(rows),
  } satisfies YearlyReportSummary;
}

export function reportStatistics(dataset: ReportsDataset, now = new Date()) {
  const rows = completedServiceReportRows(dataset);
  const currentYear = rows.filter(({ service }) =>
    service.serviceDate.startsWith(`${now.getFullYear()}-`),
  );
  const highest = (matches: (row: ServiceReportRow) => boolean) =>
    rows.filter(matches).sort((a, b) => b.total - a.total)[0];
  return {
    highestEver: highest(() => true),
    highestSundayMorning: highest(
      ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "am",
    ),
    highestSundayEvening: highest(
      ({ service }) => /sunday/i.test(service.serviceType) && period(service) === "pm",
    ),
    highestWednesday: highest(({ service }) => /wednesday/i.test(service.serviceType)),
    largestVisitorService: [...rows].sort((a, b) => b.visitors - a.visitors)[0],
    largestSundaySchool: [...rows].sort(
      (a, b) => b.sundaySchoolKids - a.sundaySchoolKids,
    )[0],
    averageThisYear: average(currentYear),
    averageAllTime: average(rows),
  };
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function reportCsv(headers: string[], rows: unknown[][]) {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
