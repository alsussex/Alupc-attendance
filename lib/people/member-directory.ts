import type { Person } from "@/lib/domain";

export type MemberDirectoryView = "active" | "inactive" | "all";

export const DEFAULT_MEMBER_DIRECTORY_VIEW: MemberDirectoryView = "active";

export function filterDirectoryMembers(
  people: Person[],
  view: MemberDirectoryView,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  return people.filter((person) => {
    const matchesView =
      view === "all" ||
      (view === "active" ? person.isActive : !person.isActive);
    return (
      matchesView &&
      person.displayName.toLocaleLowerCase().includes(normalized)
    );
  });
}
