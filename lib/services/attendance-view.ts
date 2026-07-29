import type { Person, ServiceVisitor } from "@/lib/domain";

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

export function attendancePresentCounts(
  presentMemberIds: ReadonlySet<string>,
  visitors: ServiceVisitor[],
  includeVisitors = true,
  unnamedVisitorCount = 0,
) {
  const visitorCount =
    visitors.filter(
      (visitor) => !visitor.deletedAt && !visitor.savedAsMember,
    ).length + Math.max(0, unnamedVisitorCount);
  return {
    total: presentMemberIds.size + (includeVisitors ? visitorCount : 0),
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
