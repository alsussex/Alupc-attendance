"use client";

import type {
  AttendanceRecord,
  ChurchService,
  Person,
  ServiceVisitor,
  SyncQueueItem,
  UserContext,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fromCloudRecord } from "@/lib/sync/serialization";

const PAGE_SIZE = 500;
const SERVICE_ID_BATCH_SIZE = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const COLUMNS = {
  services:
    "id,organization_id,service_date,service_type,custom_name,service_time,notes,status,unnamed_visitor_count,sunday_school_kids_count,is_archived,deleted_at,version,created_by,updated_by,created_at,updated_at",
  people:
    "id,organization_id,first_name,last_name,display_name,person_type,is_active,duplicate_name_allowed,email,phone,inactive_at,restored_at,deleted_at,merged_into_id,merged_from_ids,version,created_by,updated_by,created_at,updated_at",
  service_attendance:
    "id,organization_id,service_id,person_id,present,version,created_by,updated_by,created_at,updated_at",
  service_visitors:
    "id,organization_id,service_id,first_name,last_name,display_name,saved_as_member,member_person_id,notes,deleted_at,version,created_by,updated_by,created_at,updated_at",
} as const;

export interface AttendanceExportCloudSnapshot {
  services: Record<string, unknown>[];
  people: Record<string, unknown>[];
  attendance: Record<string, unknown>[];
  visitors: Record<string, unknown>[];
}

export interface MonthlyAttendanceSource {
  fetchRange(
    organizationId: string,
    startDate: string,
    endDateExclusive: string,
    options?: { completedOnly?: boolean },
  ): Promise<AttendanceExportCloudSnapshot>;
}

export interface MonthlyAttendanceDataset {
  monthKey: string;
  year: number;
  month: number;
  dateRange?: {
    startDate: string;
    endDate: string;
  };
  services: ChurchService[];
  members: Person[];
  attendance: AttendanceRecord[];
  visitors: ServiceVisitor[];
}

interface ExportRange {
  key: string;
  startDate: string;
  endDate: string;
  endDateExclusive: string;
}

interface PageResult {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

interface PageQuery {
  range(from: number, to: number): PromiseLike<PageResult>;
}

function addUtcDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function isRealIsoDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function attendanceDateRange(startDate: string, endDate: string) {
  if (!startDate || !isRealIsoDate(startDate)) {
    throw new Error("Choose a valid start date.");
  }
  if (!endDate || !isRealIsoDate(endDate)) {
    throw new Error("Choose a valid end date.");
  }
  if (endDate < startDate) {
    throw new Error("The end date cannot be earlier than the start date.");
  }
  return {
    key: `range:${startDate}:${endDate}`,
    startDate,
    endDate,
    endDateExclusive: addUtcDays(endDate, 1),
  };
}

function monthBounds(year: number, month: number): ExportRange {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error("Choose a valid export year.");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Choose a valid export month.");
  }
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endDateExclusive = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return {
    key,
    startDate: `${key}-01`,
    endDate: addUtcDays(endDateExclusive, -1),
    endDateExclusive,
  };
}

async function fetchAllPages(createQuery: () => PageQuery) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await createQuery().range(
      offset,
      offset + PAGE_SIZE - 1,
    );
    if (error) {
      throw new Error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
    }
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function fetchForServiceBatches(
  serviceIds: string[],
  createQuery: (ids: string[]) => PageQuery,
) {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < serviceIds.length; index += SERVICE_ID_BATCH_SIZE) {
    const ids = serviceIds.slice(index, index + SERVICE_ID_BATCH_SIZE);
    rows.push(...(await fetchAllPages(() => createQuery(ids))));
  }
  return rows;
}

export function createSupabaseMonthlyAttendanceSource(): MonthlyAttendanceSource {
  return {
    async fetchRange(
      organizationId,
      startDate,
      endDateExclusive,
      options = {},
    ) {
      const client = getSupabaseClient();
      const services = await fetchAllPages(() => {
        let query = client
          .from("services")
          .select(COLUMNS.services)
          .eq("organization_id", organizationId)
          .gte("service_date", startDate)
          .lt("service_date", endDateExclusive)
          .is("deleted_at", null);
        if (options.completedOnly) {
          query = query.eq("status", "completed");
        }
        return query
          .order("service_date", { ascending: true })
          .order("service_time", { ascending: true, nullsFirst: false })
          .order("id", { ascending: true });
      });
      const serviceIds = services.map((service) => String(service.id));
      if (serviceIds.length === 0) {
        return {
          services,
          people: [],
          attendance: [],
          visitors: [],
        };
      }
      const [attendance, visitors] = await Promise.all([
        fetchForServiceBatches(serviceIds, (ids) =>
          client
            .from("service_attendance")
            .select(COLUMNS.service_attendance)
            .eq("organization_id", organizationId)
            .in("service_id", ids)
            .order("service_id", { ascending: true })
            .order("id", { ascending: true }),
        ),
        fetchForServiceBatches(serviceIds, (ids) =>
          client
            .from("service_visitors")
            .select(COLUMNS.service_visitors)
            .eq("organization_id", organizationId)
            .in("service_id", ids)
            .is("deleted_at", null)
            .order("service_id", { ascending: true })
            .order("id", { ascending: true }),
        ),
      ]);
      const attendedPersonIds = [
        ...new Set(
          attendance
            .filter((row) => row.present === true)
            .map((row) => String(row.person_id)),
        ),
      ];
      const [activePeople, historicalPeople] = await Promise.all([
        fetchAllPages(() =>
          client
            .from("people")
            .select(COLUMNS.people)
            .eq("organization_id", organizationId)
            .eq("person_type", "member")
            .eq("is_active", true)
            .is("deleted_at", null)
            .is("merged_into_id", null)
            .order("id", { ascending: true }),
        ),
        fetchForServiceBatches(attendedPersonIds, (ids) =>
          client
            .from("people")
            .select(COLUMNS.people)
            .eq("organization_id", organizationId)
            .eq("person_type", "member")
            .in("id", ids)
            .order("id", { ascending: true }),
        ),
      ]);
      const people = [
        ...new Map(
          [...activePeople, ...historicalPeople].map((person) => [
            String(person.id),
            person,
          ]),
        ).values(),
      ];
      return { services, people, attendance, visitors };
    },
  };
}

function comparePeople(
  left: Pick<Person | ServiceVisitor, "firstName" | "lastName" | "id">,
  right: Pick<Person | ServiceVisitor, "firstName" | "lastName" | "id">,
) {
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  return (
    collator.compare(left.lastName || left.firstName, right.lastName || right.firstName) ||
    collator.compare(left.firstName, right.firstName) ||
    left.id.localeCompare(right.id)
  );
}

function recordOrganizationId(record: { organizationId: string }, user: UserContext) {
  if (record.organizationId !== user.organizationId) {
    throw new Error("Cloud export data failed its organization isolation check.");
  }
}

function buildDatasetFromCloud(
  user: UserContext,
  range: ExportRange,
  completedOnly: boolean,
  snapshot: AttendanceExportCloudSnapshot,
  dateRange?: MonthlyAttendanceDataset["dateRange"],
): MonthlyAttendanceDataset {
  const serviceIdsSeen = new Set<string>();
  const services = snapshot.services
    .map((row) => fromCloudRecord("services", row) as ChurchService)
    .filter((service) => {
      recordOrganizationId(service, user);
      if (serviceIdsSeen.has(service.id)) {
        throw new Error("Cloud export data contained a duplicate service record.");
      }
      serviceIdsSeen.add(service.id);
      return (
        !service.deletedAt &&
        service.serviceDate >= range.startDate &&
        service.serviceDate < range.endDateExclusive &&
        (!completedOnly || service.status === "completed")
      );
    })
    .sort(
      (left, right) =>
        left.serviceDate.localeCompare(right.serviceDate) ||
        (left.serviceTime ?? "23:59").localeCompare(
          right.serviceTime ?? "23:59",
        ) ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  if (services.length === 0) {
    throw new Error(
      completedOnly
        ? `No completed services were found for the selected ${dateRange ? "date range" : "month"}.`
        : `No services were found for the selected ${dateRange ? "date range" : "month"}.`,
    );
  }

  const serviceIds = new Set(services.map((service) => service.id));
  const attendance = snapshot.attendance
    .map((row) => fromCloudRecord("service_attendance", row) as AttendanceRecord)
    .filter((record) => {
      recordOrganizationId(record, user);
      return serviceIds.has(record.serviceId);
    });
  const visitors = snapshot.visitors
    .map((row) => fromCloudRecord("service_visitors", row) as ServiceVisitor)
    .filter((visitor) => {
      recordOrganizationId(visitor, user);
      return (
        serviceIds.has(visitor.serviceId) &&
        !visitor.deletedAt &&
        !visitor.savedAsMember
      );
    })
    .sort(comparePeople);
  const people = snapshot.people
    .map((row) => fromCloudRecord("people", row) as Person)
    .filter((person) => {
      recordOrganizationId(person, user);
      return person.personType === "member";
    });
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const attendedMemberIds = new Set(
    attendance.filter((record) => record.present).map((record) => record.personId),
  );
  for (const personId of attendedMemberIds) {
    if (!peopleById.has(personId)) {
      throw new Error(
        "Cloud attendance data is incomplete because an attendee name could not be loaded.",
      );
    }
  }
  const members = people
    .filter(
      (person) =>
        (person.isActive && !person.deletedAt && !person.mergedIntoId) ||
        attendedMemberIds.has(person.id),
    )
    .sort(comparePeople);

  return {
    monthKey: range.key,
    year: Number(range.startDate.slice(0, 4)),
    month: Number(range.startDate.slice(5, 7)),
    dateRange,
    services,
    members,
    attendance,
    visitors,
  };
}

function serviceDateFromMutation(item: SyncQueueItem) {
  const current = item.payload.service_date;
  if (typeof current === "string") return current;
  const base = item.basePayload?.service_date;
  return typeof base === "string" ? base : undefined;
}

function dateInRange(date: string | undefined, range: ExportRange) {
  return Boolean(
    date && date >= range.startDate && date < range.endDateExclusive,
  );
}

export async function findRelevantPendingExportChanges(
  user: UserContext,
  startDate: string,
  endDate: string,
) {
  const range = attendanceDateRange(startDate, endDate);
  const database = await getDatabase();
  const [queue, services] = await Promise.all([
    database.getAllFromIndex("syncQueue", "organizationId", user.organizationId),
    database.getAllFromIndex("services", "organizationId", user.organizationId),
  ]);
  const serviceDates = new Map(
    services.map((service) => [service.id, service.serviceDate]),
  );
  for (const item of queue) {
    if (item.table === "services") {
      const queuedDate = serviceDateFromMutation(item);
      if (queuedDate) serviceDates.set(item.recordId, queuedDate);
    }
  }
  return queue.filter((item) => {
    if (item.table === "people") return true;
    if (item.table === "services") {
      return (
        dateInRange(serviceDateFromMutation(item), range) ||
        dateInRange(
          typeof item.basePayload?.service_date === "string"
            ? item.basePayload.service_date
            : undefined,
          range,
        )
      );
    }
    if (
      item.table === "service_attendance" ||
      item.table === "service_visitors"
    ) {
      const serviceId = item.payload.service_id;
      if (typeof serviceId !== "string") return true;
      const serviceDate = serviceDates.get(serviceId);
      return serviceDate ? dateInRange(serviceDate, range) : true;
    }
    return false;
  });
}

async function loadCloudAttendanceDataset(
  user: UserContext,
  range: ExportRange,
  completedOnly: boolean,
  options: {
    online?: boolean;
    source?: MonthlyAttendanceSource;
    dateRange?: MonthlyAttendanceDataset["dateRange"];
  } = {},
) {
  const online =
    options.online ??
    (typeof navigator !== "undefined" && navigator.onLine === true);
  if (!online) {
    throw new Error("An internet connection is required to export attendance.");
  }
  const pending = await findRelevantPendingExportChanges(
    user,
    range.startDate,
    range.endDate,
  );
  if (pending.length > 0) {
    throw new Error(
      `${pending.length} unsynced ${pending.length === 1 ? "change affects" : "changes affect"} this export. Sync all pending changes before exporting attendance, then try again.`,
    );
  }
  try {
    const snapshot = await (
      options.source ?? createSupabaseMonthlyAttendanceSource()
    ).fetchRange(user.organizationId, range.startDate, range.endDateExclusive, {
      completedOnly,
    });
    return buildDatasetFromCloud(
      user,
      range,
      completedOnly,
      snapshot,
      options.dateRange,
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Cloud request failed.";
    if (
      message.startsWith("No services") ||
      message.startsWith("No completed services") ||
      message.startsWith("Cloud attendance data is incomplete")
    ) {
      throw caught;
    }
    throw new Error(
      `Attendance could not be exported because the cloud data could not be loaded completely. ${message}`,
    );
  }
}

export async function loadCloudMonthlyAttendanceDataset(
  user: UserContext,
  year: number,
  month: number,
  completedOnly: boolean,
  options: { online?: boolean; source?: MonthlyAttendanceSource } = {},
) {
  return loadCloudAttendanceDataset(
    user,
    monthBounds(year, month),
    completedOnly,
    options,
  );
}

export async function loadCloudCustomAttendanceRangeDataset(
  user: UserContext,
  startDate: string,
  endDate: string,
  completedOnly: boolean,
  options: { online?: boolean; source?: MonthlyAttendanceSource } = {},
) {
  const range = attendanceDateRange(startDate, endDate);
  return loadCloudAttendanceDataset(user, range, completedOnly, {
    ...options,
    dateRange: { startDate, endDate },
  });
}
