import type { Person } from "@/lib/domain";

export type MemberDirectoryView =
  | "active"
  | "inactive"
  | "all"
  | "recently_added"
  | "recently_restored";
export type MemberDirectorySort =
  | "name"
  | "date_added"
  | "last_attendance"
  | "attendance_count";

export const DEFAULT_MEMBER_DIRECTORY_VIEW: MemberDirectoryView = "active";

export function filterDirectoryMembers(
  people: Person[],
  view: MemberDirectoryView,
  query: string,
  now = new Date(),
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const recentCutoff = new Date(now);
  recentCutoff.setDate(recentCutoff.getDate() - 30);
  const cutoff = recentCutoff.toISOString();
  return people.filter((person) => {
    const matchesView =
      view === "all" ||
      (view === "active"
        ? person.isActive
        : view === "inactive"
          ? !person.isActive
          : view === "recently_added"
            ? person.createdAt >= cutoff
            : Boolean(person.restoredAt && person.restoredAt >= cutoff));
    const searchable = [
      person.displayName,
      person.firstName,
      person.lastName,
      person.email,
      person.phone,
      person.isActive ? "active" : "inactive",
    ]
      .join(" ")
      .toLocaleLowerCase();
    return matchesView && terms.every((term) => searchable.includes(term));
  });
}

export function sortDirectoryMembers(
  people: Person[],
  sort: MemberDirectorySort,
  lastAttendance: ReadonlyMap<string, string>,
  attendanceCounts: ReadonlyMap<string, number>,
) {
  const byName = (left: Person, right: Person) =>
    left.lastName.localeCompare(right.lastName) ||
    left.firstName.localeCompare(right.firstName) ||
    left.id.localeCompare(right.id);
  return [...people].sort((left, right) => {
    if (sort === "date_added") {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        byName(left, right)
      );
    }
    if (sort === "last_attendance") {
      return (
        (lastAttendance.get(right.id) ?? "").localeCompare(
          lastAttendance.get(left.id) ?? "",
        ) || byName(left, right)
      );
    }
    if (sort === "attendance_count") {
      return (
        (attendanceCounts.get(right.id) ?? 0) -
          (attendanceCounts.get(left.id) ?? 0) ||
        byName(left, right)
      );
    }
    return byName(left, right);
  });
}
