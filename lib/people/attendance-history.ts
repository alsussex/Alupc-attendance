"use client";

import type {
  AttendanceRecord,
  ChurchService,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";

export type AttendanceHistoryPeriod =
  | "all"
  | "year"
  | "month"
  | "last_30_days";

export interface MemberAttendanceHistoryEntry {
  attendanceId: string;
  serviceId: string;
  serviceName: string;
  serviceType: string;
  serviceDate: string;
  serviceTime?: string;
  serviceStatus: ChurchService["status"];
}

export interface MemberAttendanceSummary {
  lastAttendedDate?: string;
  totalServices: number;
  thisMonth: number;
  thisYear: number;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

export function buildMemberAttendanceHistory(
  attendance: AttendanceRecord[],
  services: ChurchService[],
  organizationId: string,
  personId: string,
) {
  const serviceById = new Map(
    services
      .filter(
        (service) =>
          service.organizationId === organizationId && !service.deletedAt,
      )
      .map((service) => [service.id, service]),
  );

  return attendance
    .filter(
      (record) =>
        record.organizationId === organizationId &&
        record.personId === personId &&
        record.present,
    )
    .flatMap((record): MemberAttendanceHistoryEntry[] => {
      const service = serviceById.get(record.serviceId);
      if (!service) return [];
      return [
        {
          attendanceId: record.id,
          serviceId: service.id,
          serviceName: serviceTitle(service),
          serviceType: service.serviceType,
          serviceDate: service.serviceDate,
          serviceTime: service.serviceTime,
          serviceStatus: service.status,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.serviceDate.localeCompare(left.serviceDate) ||
        (right.serviceTime ?? "").localeCompare(left.serviceTime ?? "") ||
        right.attendanceId.localeCompare(left.attendanceId),
    );
}

export function summarizeMemberAttendance(
  entries: MemberAttendanceHistoryEntry[],
  currentDate = new Date(),
): MemberAttendanceSummary {
  const today = localDateKey(currentDate);
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  return {
    lastAttendedDate: entries[0]?.serviceDate,
    totalServices: entries.length,
    thisMonth: entries.filter((entry) =>
      entry.serviceDate.startsWith(month),
    ).length,
    thisYear: entries.filter((entry) =>
      entry.serviceDate.startsWith(year),
    ).length,
  };
}

export function filterMemberAttendanceHistory(
  entries: MemberAttendanceHistoryEntry[],
  period: AttendanceHistoryPeriod,
  serviceType: string,
  currentDate = new Date(),
) {
  const today = localDateKey(currentDate);
  const currentYear = today.slice(0, 4);
  const currentMonth = today.slice(0, 7);
  const cutoff = new Date(
    Date.UTC(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate() - 29,
    ),
  )
    .toISOString()
    .slice(0, 10);

  return entries.filter((entry) => {
    if (serviceType !== "all" && entry.serviceType !== serviceType) {
      return false;
    }
    if (period === "year") return entry.serviceDate.startsWith(currentYear);
    if (period === "month") return entry.serviceDate.startsWith(currentMonth);
    if (period === "last_30_days") {
      return entry.serviceDate >= cutoff && entry.serviceDate <= today;
    }
    return true;
  });
}

export function serviceTypeAttendanceTotals(
  entries: MemberAttendanceHistoryEntry[],
) {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    totals.set(entry.serviceType, (totals.get(entry.serviceType) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([serviceType, total]) => ({ serviceType, total }))
    .sort(
      (left, right) =>
        right.total - left.total ||
        left.serviceType.localeCompare(right.serviceType),
    );
}

export async function loadMemberAttendanceHistory(
  organizationId: string,
  personId: string,
) {
  const database = await getDatabase();
  const [attendance, services] = await Promise.all([
    database.getAllFromIndex("attendance", "organizationId", organizationId),
    database.getAllFromIndex("services", "organizationId", organizationId),
  ]);
  return buildMemberAttendanceHistory(
    attendance,
    services,
    organizationId,
    personId,
  );
}
