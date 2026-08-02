"use client";

import {
  attendanceId,
  type AttendanceRecord,
  type ChurchService,
  type Person,
  type ServiceVisitor,
  type UserContext,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fromCloudRecord } from "@/lib/sync/serialization";

const PAGE_SIZE = 500;
const SERVICE_ID_BATCH_SIZE = 100;

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

export interface MonthlyCloudSnapshot {
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
    options?: { includePeople?: boolean },
  ): Promise<MonthlyCloudSnapshot>;
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

interface PageResult {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

interface PageQuery {
  range(from: number, to: number): PromiseLike<PageResult>;
}

function monthKey(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    throw new Error("Choose a valid export year.");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("Choose a valid export month.");
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

function monthBounds(year: number, month: number) {
  const key = monthKey(year, month);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    key,
    startDate: `${key}-01`,
    endDate: addUtcDays(
      `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
      -1,
    ),
    endDateExclusive: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
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
      const services = await fetchAllPages(() =>
        client
          .from("services")
          .select(COLUMNS.services)
          .eq("organization_id", organizationId)
          .gte("service_date", startDate)
          .lt("service_date", endDateExclusive)
          .order("service_date", { ascending: true })
          .order("id", { ascending: true }),
      );
      const serviceIds = services.map((service) => String(service.id));
      const peoplePromise = options.includePeople === false
        ? Promise.resolve([])
        : fetchAllPages(() =>
            client
              .from("people")
              .select(COLUMNS.people)
              .eq("organization_id", organizationId)
              .eq("person_type", "member")
              .order("id", { ascending: true }),
          );
      if (serviceIds.length === 0) {
        return {
          services,
          people: await peoplePromise,
          attendance: [],
          visitors: [],
        };
      }
      const [people, attendance, visitors] = await Promise.all([
        peoplePromise,
        fetchForServiceBatches(serviceIds, (ids) =>
          client
            .from("service_attendance")
            .select(COLUMNS.service_attendance)
            .eq("organization_id", organizationId)
            .in("service_id", ids)
            .order("updated_at", { ascending: true })
            .order("id", { ascending: true }),
        ),
        fetchForServiceBatches(serviceIds, (ids) =>
          client
            .from("service_visitors")
            .select(COLUMNS.service_visitors)
            .eq("organization_id", organizationId)
            .in("service_id", ids)
            .order("updated_at", { ascending: true })
            .order("id", { ascending: true }),
        ),
      ]);
      return { services, people, attendance, visitors };
    },
  };
}

function coverageId(user: UserContext, key: string) {
  return `${user.userId}:${user.organizationId}:${key}`;
}

interface CoverageBounds {
  key: string;
  startDate: string;
  endDate: string;
  endDateExclusive: string;
}

function storedCoverageBounds(coverage: {
  monthKey: string;
  startDate?: string;
  endDateExclusive?: string;
}) {
  if (coverage.startDate && coverage.endDateExclusive) {
    return {
      startDate: coverage.startDate,
      endDateExclusive: coverage.endDateExclusive,
    };
  }
  const match = /^(\d{4})-(\d{2})$/.exec(coverage.monthKey);
  if (!match) return null;
  const bounds = monthBounds(Number(match[1]), Number(match[2]));
  return {
    startDate: bounds.startDate,
    endDateExclusive: bounds.endDateExclusive,
  };
}

async function missingCoverageRanges(user: UserContext, bounds: CoverageBounds) {
  const database = await getDatabase();
  const coverage = await database.getAllFromIndex(
    "monthlyExportCoverage",
    "organizationId",
    user.organizationId,
  );
  const intervals = coverage
    .filter((entry) => entry.userId === user.userId)
    .map(storedCoverageBounds)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter(
      (entry) =>
        entry.endDateExclusive > bounds.startDate &&
        entry.startDate < bounds.endDateExclusive,
    )
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  const missing: Array<{ startDate: string; endDateExclusive: string }> = [];
  let cursor = bounds.startDate;
  for (const interval of intervals) {
    if (interval.endDateExclusive <= cursor) continue;
    if (interval.startDate > cursor) {
      missing.push({
        startDate: cursor,
        endDateExclusive:
          interval.startDate < bounds.endDateExclusive
            ? interval.startDate
            : bounds.endDateExclusive,
      });
    }
    if (interval.endDateExclusive > cursor) {
      cursor = interval.endDateExclusive;
    }
    if (cursor >= bounds.endDateExclusive) break;
  }
  if (cursor < bounds.endDateExclusive) {
    missing.push({ startDate: cursor, endDateExclusive: bounds.endDateExclusive });
  }
  return missing.filter((range) => range.startDate < range.endDateExclusive);
}

async function hasAttendanceCoverage(user: UserContext) {
  const database = await getDatabase();
  const coverage = await database.getAllFromIndex(
    "monthlyExportCoverage",
    "organizationId",
    user.organizationId,
  );
  return coverage.some((entry) => entry.userId === user.userId);
}

async function mergeMonthlySnapshot(
  user: UserContext,
  snapshot: MonthlyCloudSnapshot,
) {
  const database = await getDatabase();
  const queue = await database.getAllFromIndex(
    "syncQueue",
    "organizationId",
    user.organizationId,
  );
  const pending = new Set(
    queue.map((item) => `${item.table}:${item.recordId}`),
  );

  for (const row of snapshot.services) {
    const service = fromCloudRecord("services", row) as ChurchService;
    if (service.organizationId !== user.organizationId) {
      throw new Error("Organization isolation check failed.");
    }
    if (!pending.has(`services:${service.id}`)) {
      await database.put("services", service);
    }
  }
  for (const row of snapshot.people) {
    const person = fromCloudRecord("people", row) as Person;
    if (person.organizationId !== user.organizationId) {
      throw new Error("Organization isolation check failed.");
    }
    if (!pending.has(`people:${person.id}`)) {
      await database.put("people", person);
    }
  }
  for (const row of snapshot.attendance) {
    const record = fromCloudRecord(
      "service_attendance",
      row,
    ) as AttendanceRecord;
    if (record.organizationId !== user.organizationId) {
      throw new Error("Organization isolation check failed.");
    }
    const id = attendanceId(record.serviceId, record.personId);
    if (!pending.has(`service_attendance:${id}`)) {
      await database.put("attendance", { ...record, id });
    }
  }
  for (const row of snapshot.visitors) {
    const visitor = fromCloudRecord(
      "service_visitors",
      row,
    ) as ServiceVisitor;
    if (visitor.organizationId !== user.organizationId) {
      throw new Error("Organization isolation check failed.");
    }
    if (!pending.has(`service_visitors:${visitor.id}`)) {
      await database.put("visitors", visitor);
    }
  }
}

async function isAttendanceRangeCacheComplete(
  user: UserContext,
  bounds: CoverageBounds,
) {
  return (await missingCoverageRanges(user, bounds)).length === 0;
}

export async function isMonthlyAttendanceCacheComplete(
  user: UserContext,
  year: number,
  month: number,
) {
  return isAttendanceRangeCacheComplete(user, monthBounds(year, month));
}

export async function isCustomAttendanceRangeCacheComplete(
  user: UserContext,
  startDate: string,
  endDate: string,
) {
  return isAttendanceRangeCacheComplete(
    user,
    attendanceDateRange(startDate, endDate),
  );
}

async function ensureAttendanceCoverage(
  user: UserContext,
  bounds: CoverageBounds,
  label: string,
  options: {
    online?: boolean;
    source?: MonthlyAttendanceSource;
  } = {},
) {
  const missing = await missingCoverageRanges(user, bounds);
  if (missing.length === 0) return;

  const online =
    options.online ??
    (typeof navigator !== "undefined" && navigator.onLine === true);
  if (!online) {
    throw new Error(
      `${label} has not been fully saved on this device. Connect to the internet once, then try the export again.`,
    );
  }

  const database = await getDatabase();
  const source = options.source ?? createSupabaseMonthlyAttendanceSource();
  const includePeople = !(await hasAttendanceCoverage(user));
  try {
    for (const [index, range] of missing.entries()) {
      const snapshot = await source.fetchRange(
        user.organizationId,
        range.startDate,
        range.endDateExclusive,
        { includePeople: includePeople && index === 0 },
      );
      await mergeMonthlySnapshot(user, snapshot);
      const rangeEnd = addUtcDays(range.endDateExclusive, -1);
      const rangeKey = `range:${range.startDate}:${rangeEnd}`;
      await database.put("monthlyExportCoverage", {
        id: coverageId(user, rangeKey),
        userId: user.userId,
        organizationId: user.organizationId,
        monthKey: rangeKey,
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
        verifiedAt: new Date().toISOString(),
      });
    }
    announceDataChanged();
  } catch (caught) {
    throw new Error(
      `The selected ${label.toLocaleLowerCase()} could not be fully loaded, so no workbook was created. ${
        caught instanceof Error ? caught.message : "Try again while online."
      }`,
    );
  }
}

export async function ensureMonthlyAttendanceCache(
  user: UserContext,
  year: number,
  month: number,
  options: {
    online?: boolean;
    source?: MonthlyAttendanceSource;
  } = {},
) {
  const bounds = monthBounds(year, month);
  await ensureAttendanceCoverage(user, bounds, "month", options);
}

export async function ensureCustomAttendanceRangeCache(
  user: UserContext,
  startDate: string,
  endDate: string,
  options: {
    online?: boolean;
    source?: MonthlyAttendanceSource;
  } = {},
) {
  await ensureAttendanceCoverage(
    user,
    attendanceDateRange(startDate, endDate),
    "date range",
    options,
  );
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

async function loadAttendanceDataset(
  user: UserContext,
  bounds: CoverageBounds,
  completedOnly: boolean,
  dateRange?: MonthlyAttendanceDataset["dateRange"],
): Promise<MonthlyAttendanceDataset> {
  const database = await getDatabase();
  const [services, people, attendance, visitors] = await Promise.all([
    database.getAllFromIndex("services", "organizationId", user.organizationId),
    database.getAllFromIndex("people", "organizationId", user.organizationId),
    database.getAllFromIndex("attendance", "organizationId", user.organizationId),
    database.getAllFromIndex("visitors", "organizationId", user.organizationId),
  ]);
  const selectedServices = services
    .filter(
      (service) =>
        !service.deletedAt &&
        service.serviceDate >= bounds.startDate &&
        service.serviceDate < bounds.endDateExclusive &&
        (!completedOnly || service.status === "completed"),
    )
    .sort(
      (left, right) =>
        left.serviceDate.localeCompare(right.serviceDate) ||
        (left.serviceTime ?? "23:59").localeCompare(
          right.serviceTime ?? "23:59",
        ) ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  if (selectedServices.length === 0) {
    throw new Error(
      completedOnly
        ? `No completed services were found for the selected ${dateRange ? "date range" : "month"}.`
        : `No services were found for the selected ${dateRange ? "date range" : "month"}.`,
    );
  }
  const serviceIds = new Set(selectedServices.map((service) => service.id));
  const selectedAttendance = attendance.filter((record) =>
    serviceIds.has(record.serviceId),
  );
  const attendedMemberIds = new Set(
    selectedAttendance
      .filter((record) => record.present)
      .map((record) => record.personId),
  );
  const members = people
    .filter(
      (person) =>
        person.personType === "member" &&
        ((person.isActive && !person.deletedAt && !person.mergedIntoId) ||
          attendedMemberIds.has(person.id)),
    )
    .sort(comparePeople);
  const selectedVisitors = visitors
    .filter(
      (visitor) =>
        serviceIds.has(visitor.serviceId) &&
        !visitor.deletedAt &&
        !visitor.savedAsMember,
    )
    .sort(comparePeople);

  return {
    monthKey: bounds.key,
    year: Number(bounds.startDate.slice(0, 4)),
    month: Number(bounds.startDate.slice(5, 7)),
    dateRange,
    services: selectedServices,
    members,
    attendance: selectedAttendance,
    visitors: selectedVisitors,
  };
}

export async function loadMonthlyAttendanceDataset(
  user: UserContext,
  year: number,
  month: number,
  completedOnly: boolean,
) {
  return loadAttendanceDataset(
    user,
    monthBounds(year, month),
    completedOnly,
  );
}

export async function loadCustomAttendanceRangeDataset(
  user: UserContext,
  startDate: string,
  endDate: string,
  completedOnly: boolean,
) {
  const bounds = attendanceDateRange(startDate, endDate);
  return loadAttendanceDataset(user, bounds, completedOnly, {
    startDate: bounds.startDate,
    endDate: bounds.endDate,
  });
}
