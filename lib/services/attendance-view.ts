import type { Person, ServiceVisitor } from "@/lib/domain";
import {
  countNamedChildProgramVisitors,
  countNamedVisitors,
  countVisitors,
  normalizeSundaySchoolKidsCount,
  normalizeUnnamedVisitorCount,
} from "@/lib/services/attendance-summary";

export type AttendanceFilter = "all" | "present" | "absent";

export function attendanceCounts(
  members: Person[],
  presentMemberIds: ReadonlySet<string>,
) {
  const present = members.filter((member) =>
    presentMemberIds.has(member.id),
  ).length;
  return {
    present,
    absent: members.length - present,
    total: members.length,
  };
}

export function filterAttendanceMembers(
  members: Person[],
  presentMemberIds: ReadonlySet<string>,
  filter: AttendanceFilter,
  query: string,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return members.filter((member) => {
    const isPresent = presentMemberIds.has(member.id);
    const matchesFilter =
      filter === "all" ||
      (filter === "present" && isPresent) ||
      (filter === "absent" && !isPresent);
    return (
      matchesFilter &&
      member.displayName.toLocaleLowerCase().includes(normalizedQuery)
    );
  });
}

export function visibleServiceMembers(
  members: Person[],
  presentMemberIds: ReadonlySet<string>,
  completed: boolean,
  filter: AttendanceFilter,
  query: string,
) {
  if (completed) {
    return members.filter((member) => presentMemberIds.has(member.id));
  }
  return filterAttendanceMembers(members, presentMemberIds, filter, query);
}

export function attendancePresentCounts(
  presentMemberIds: ReadonlySet<string>,
  visitors: ServiceVisitor[],
  includeVisitors = true,
  unnamedVisitorCount = 0,
  sundaySchoolKidsCount = 0,
  serviceType?: string,
) {
  const visitorCount = countVisitors(visitors, unnamedVisitorCount, serviceType);
  const classifiedChildCount = countNamedChildProgramVisitors(
    visitors,
    serviceType,
  );
  return {
    total:
      presentMemberIds.size +
      (includeVisitors ? visitorCount : 0) +
      Math.max(0, Math.trunc(sundaySchoolKidsCount)) + classifiedChildCount,
    members: presentMemberIds.size,
    visitors: visitorCount,
  };
}

export function attendanceVisitorBreakdown(
  visitors: ServiceVisitor[],
  unnamedVisitorCount = 0,
  sundaySchoolKidsCount = 0,
  serviceType?: string,
) {
  const allNamed = countNamedVisitors(visitors);
  const namedChildren = countNamedChildProgramVisitors(visitors, serviceType);
  const named = allNamed - namedChildren;
  const unnamed = normalizeUnnamedVisitorCount(unnamedVisitorCount);
  const unnamedChildren = normalizeSundaySchoolKidsCount(sundaySchoolKidsCount);
  const children = namedChildren + unnamedChildren;
  return {
    named,
    unnamed,
    namedChildren,
    unnamedChildren,
    children,
    total: named + unnamed + children,
  };
}

export function filterAttendanceVisitors(
  visitors: ServiceVisitor[],
  filter: AttendanceFilter,
  query: string,
) {
  if (filter === "absent") return [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return visitors.filter(
    (visitor) =>
      !visitor.deletedAt &&
      visitor.displayName.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function visibleServiceVisitors(
  visitors: ServiceVisitor[],
  completed: boolean,
  query: string,
) {
  return filterAttendanceVisitors(visitors, "all", completed ? "" : query);
}
