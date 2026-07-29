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
) {
  const visitorCount = includeVisitors
    ? visitors.filter(
        (visitor) => !visitor.deletedAt && !visitor.savedAsMember,
      ).length
    : 0;
  return {
    total: presentMemberIds.size + visitorCount,
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
