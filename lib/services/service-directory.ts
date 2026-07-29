"use client";

import type {
  AttendanceRecord,
  ChurchService,
  Profile,
  ServiceVisitor,
  SyncQueueItem,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";

export type ServiceDirectoryFilter = "all" | "draft" | "completed";

export interface ServiceDirectoryItem {
  service: ChurchService;
  membersPresent: number;
  visitorsPresent: number;
  totalPresent: number;
  lastEditor?: string;
  pendingSync: boolean;
}

export interface ServiceMonthGroup {
  key: string;
  year: string;
  month: string;
  monthName: string;
  services: ServiceDirectoryItem[];
}

export interface ServiceYearGroup {
  year: string;
  serviceCount: number;
  months: ServiceMonthGroup[];
}

function serviceName(service: ChurchService) {
  return service.customName || service.serviceType;
}

function serviceSort(a: ServiceDirectoryItem, b: ServiceDirectoryItem) {
  return (
    b.service.serviceDate.localeCompare(a.service.serviceDate) ||
    (b.service.serviceTime ?? "").localeCompare(
      a.service.serviceTime ?? "",
    ) ||
    b.service.updatedAt.localeCompare(a.service.updatedAt)
  );
}

function monthName(serviceDate: string, locale?: string) {
  const [year, month] = serviceDate.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function filterServiceDirectory(
  items: ServiceDirectoryItem[],
  filter: ServiceDirectoryFilter,
  query: string,
  locale?: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter(({ service }) => {
    if (filter !== "all" && service.status !== filter) return false;
    if (!normalized) return true;
    const searchable = [
      serviceName(service),
      service.serviceType,
      service.serviceDate,
      service.serviceDate.slice(0, 4),
      monthName(service.serviceDate, locale),
      new Intl.DateTimeFormat(locale, {
        dateStyle: "long",
        timeZone: "UTC",
      }).format(new Date(`${service.serviceDate}T00:00:00Z`)),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}

export function groupServiceDirectory(
  items: ServiceDirectoryItem[],
  locale?: string,
): ServiceYearGroup[] {
  const years = new Map<string, Map<string, ServiceDirectoryItem[]>>();
  for (const item of [...items].sort(serviceSort)) {
    const year = item.service.serviceDate.slice(0, 4);
    const month = item.service.serviceDate.slice(5, 7);
    const months = years.get(year) ?? new Map<string, ServiceDirectoryItem[]>();
    months.set(month, [...(months.get(month) ?? []), item]);
    years.set(year, months);
  }
  return [...years.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, months]) => {
      const groupedMonths = [...months.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, services]) => ({
          key: `${year}-${month}`,
          year,
          month,
          monthName: monthName(services[0].service.serviceDate, locale),
          services: [...services].sort(serviceSort),
        }));
      return {
        year,
        serviceCount: groupedMonths.reduce(
          (count, group) => count + group.services.length,
          0,
        ),
        months: groupedMonths,
      };
    });
}

function queueBelongsToService(item: SyncQueueItem, serviceId: string) {
  if (item.table === "services") return item.recordId === serviceId;
  if (
    item.table !== "service_attendance" &&
    item.table !== "service_visitors"
  ) {
    return false;
  }
  return item.payload.service_id === serviceId;
}

export function summarizeOrganizationServices(
  services: ChurchService[],
  attendance: AttendanceRecord[],
  visitors: ServiceVisitor[],
  profiles: Profile[],
  queue: SyncQueueItem[],
) {
  const profileNames = new Map(
    profiles.map((profile) => [profile.id, profile.displayName]),
  );
  return services
    .filter((service) => !service.deletedAt && !service.isArchived)
    .map((service): ServiceDirectoryItem => {
      const membersPresent = attendance.filter(
        (record) => record.serviceId === service.id && record.present,
      ).length;
      const visitorsPresent = visitors.filter(
        (visitor) =>
          visitor.serviceId === service.id &&
          !visitor.deletedAt &&
          !visitor.savedAsMember,
      ).length;
      return {
        service,
        membersPresent,
        visitorsPresent,
        totalPresent: membersPresent + visitorsPresent,
        lastEditor: profileNames.get(service.updatedBy),
        pendingSync: queue.some((item) =>
          queueBelongsToService(item, service.id),
        ),
      };
    })
    .sort(serviceSort);
}

export async function loadOrganizationServiceDirectory(
  organizationId: string,
) {
  const database = await getDatabase();
  const [services, attendance, visitors, profiles, queue] = await Promise.all([
    database.getAllFromIndex("services", "organizationId", organizationId),
    database.getAllFromIndex("attendance", "organizationId", organizationId),
    database.getAllFromIndex("visitors", "organizationId", organizationId),
    database.getAllFromIndex("profiles", "organizationId", organizationId),
    database.getAllFromIndex("syncQueue", "organizationId", organizationId),
  ]);
  return summarizeOrganizationServices(
    services,
    attendance,
    visitors,
    profiles,
    queue,
  );
}
