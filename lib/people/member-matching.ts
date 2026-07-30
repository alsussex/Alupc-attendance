import type { Person } from "@/lib/domain";
import { normalizeName } from "@/lib/domain";

export interface MemberMatchSuggestion {
  person: Person;
  score: number;
  reason: "exact" | "punctuation" | "similar";
}

export function memberSearchKey(value: string) {
  return normalizeName(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’']/g, "")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function findLikelyMemberMatches(
  people: Person[],
  name: string,
  organizationId: string,
  excludeId?: string,
) {
  const normalized = normalizeName(name);
  const key = memberSearchKey(name);
  if (key.length < 3) return [];
  return people
    .filter(
      (person) =>
        person.organizationId === organizationId &&
        person.personType === "member" &&
        !person.mergedIntoId &&
        person.id !== excludeId,
    )
    .flatMap((person): MemberMatchSuggestion[] => {
      const candidateNormalized = normalizeName(person.displayName);
      const candidateKey = memberSearchKey(person.displayName);
      if (normalized === candidateNormalized) {
        return [{ person, score: 1, reason: "exact" }];
      }
      if (key === candidateKey) {
        return [{ person, score: 0.98, reason: "punctuation" }];
      }
      const distance = editDistance(key, candidateKey);
      const longest = Math.max(key.length, candidateKey.length);
      const score = longest ? 1 - distance / longest : 0;
      return score >= 0.8
        ? [{ person, score, reason: "similar" }]
        : [];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.person.displayName.localeCompare(right.person.displayName),
    );
}
