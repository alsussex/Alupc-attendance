"use client";

import type {
  AttendanceRecord,
  ChurchService,
  ServiceVisitor,
} from "@/lib/domain";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";
import { childProgramForService } from "@/lib/services/child-program";
import { getDatabase } from "@/lib/storage/database";

export interface DashboardService {
  id: string;
  title: string;
  serviceDate: string;
  serviceTime?: string;
  status: ChurchService["status"];
  attendanceTotal: number;
  visitorCount: number;
  sundaySchoolKidsCount?: number;
  childProgramLabel?: string;
  updatedAt: string;
}

export interface DashboardActivity {
  id: string;
  type: "person" | "service" | "attendance" | "visitor";
  message: string;
  timestamp: string;
}

export interface DashboardSnapshot {
  churchName: string;
  totalPeople: number;
  servicesThisMonth: number;
  attendanceThisMonth: number;
  visitorsThisMonth: number;
  averageAttendance: number;
  services: DashboardService[];
  draftService?: DashboardService;
  activity: DashboardActivity[];
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function summarizeService(
  service: ChurchService,
  attendance: AttendanceRecord[],
  visitors: ServiceVisitor[],
): DashboardService {
  const summary = summarizeServiceAttendance(service, attendance, visitors);
  const childProgram = childProgramForService(service.serviceType);
  return {
    id: service.id,
    title: serviceTitle(service),
    serviceDate: service.serviceDate,
    serviceTime: service.serviceTime,
    status: service.status,
    attendanceTotal: summary.totalPresent,
    visitorCount: summary.visitorTotal,
    sundaySchoolKidsCount: summary.sundaySchoolKidsCount,
    childProgramLabel: childProgram?.label,
    updatedAt: service.updatedAt,
  };
}

export async function loadDashboardSnapshot(
  organizationId: string,
  now = new Date(),
): Promise<DashboardSnapshot> {
  const database = await getDatabase();
  const [organization, people, services, attendance, storedVisitors] =
    await Promise.all([
      database.get("organizations", organizationId),
      database.getAllFromIndex("people", "organizationId", organizationId),
      database.getAllFromIndex("services", "organizationId", organizationId),
      database.getAllFromIndex(
        "attendance",
        "organizationId",
        organizationId,
      ),
      database.getAllFromIndex("visitors", "organizationId", organizationId),
    ]);

  const orderedServices = services
    .filter((service) => !service.deletedAt && !service.isArchived)
    .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  const visitors = storedVisitors.filter((visitor) => !visitor.deletedAt);
  const serviceSummaries = orderedServices.map((service) =>
    summarizeService(service, attendance, visitors),
  );
  const currentMonth = monthKey(now);
  const monthServices = serviceSummaries.filter((service) =>
    service.serviceDate.startsWith(currentMonth),
  );
  const attendanceThisMonth = monthServices.reduce(
    (sum, service) => sum + service.attendanceTotal,
    0,
  );
  const serviceById = new Map(
    orderedServices.map((service) => [service.id, service]),
  );
  const attendanceActivity = new Map<string, DashboardActivity>();

  for (const record of attendance) {
    const service = serviceById.get(record.serviceId);
    if (!service) continue;
    const existing = attendanceActivity.get(record.serviceId);
    if (!existing || record.updatedAt > existing.timestamp) {
      attendanceActivity.set(record.serviceId, {
        id: `attendance:${record.serviceId}`,
        type: "attendance",
        message: `Recorded attendance for ${serviceTitle(service)}`,
        timestamp: record.updatedAt,
      });
    }
  }

  const activity: DashboardActivity[] = [
    ...people.map((person) => ({
      id: `person:${person.id}`,
      type: "person" as const,
      message: `Added ${person.displayName}`,
      timestamp: person.createdAt,
    })),
    ...orderedServices.map((service) => ({
      id: `service:${service.id}`,
      type: "service" as const,
      message: `Created ${serviceTitle(service)}`,
      timestamp: service.createdAt,
    })),
    ...attendanceActivity.values(),
    ...visitors.map((visitor) => ({
      id: `visitor:${visitor.id}`,
      type: "visitor" as const,
      message: `Added visitor ${visitor.displayName}`,
      timestamp: visitor.createdAt,
    })),
  ]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 6);

  return {
    churchName: organization?.name || "Abundant Life UPC",
    totalPeople: people.filter(
      (person) =>
        !person.deletedAt &&
        person.isActive &&
        person.personType === "member",
    ).length,
    servicesThisMonth: monthServices.length,
    attendanceThisMonth,
    visitorsThisMonth: monthServices.reduce(
      (sum, service) => sum + service.visitorCount,
      0,
    ),
    averageAttendance: monthServices.length
      ? Math.round(attendanceThisMonth / monthServices.length)
      : 0,
    services: serviceSummaries,
    draftService: serviceSummaries.find(
      (service) => service.status === "draft",
    ),
    activity,
  };
}
