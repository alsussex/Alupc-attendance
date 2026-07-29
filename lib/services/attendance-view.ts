import type { Person } from "@/lib/domain";

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
