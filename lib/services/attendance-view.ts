import type { Person, ServiceVisitor } from "@/lib/domain";
import { countVisitors } from "@/lib/services/attendance-summary";

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
) {
  const visitorCount = countVisitors(visitors, unnamedVisitorCount);
  return {
    total:
      presentMemberIds.size +
      (includeVisitors ? visitorCount : 0) +
      Math.max(0, Math.trunc(sundaySchoolKidsCount)),
    members: presentMemberIds.size,
    visitors: visitorCount,
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
