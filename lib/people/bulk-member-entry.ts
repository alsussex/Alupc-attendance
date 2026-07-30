"use client";

import {
  normalizeName,
  type Person,
  type UserContext,
} from "@/lib/domain";
import {
  findExactMemberMatches,
  restoreMember,
  saveMember,
} from "@/lib/repositories/attendance-repository";

export type BulkMemberStatus =
  | "ready"
  | "existing"
  | "inactive"
  | "deleted"
  | "ambiguous"
  | "invalid"
  | "processed"
  | "failed";

export type BulkMemberDecision =
  | "add"
  | "restore"
  | "skip"
  | "review"
  | "create_separate";

export interface BulkMemberRow {
  id: string;
  originalLine: string;
  firstName: string;
  lastName: string;
  status: BulkMemberStatus;
  decision: BulkMemberDecision;
  matches: Person[];
  selectedMatchId?: string;
  processedPersonId?: string;
  error?: string;
}

export interface BulkMemberTotals {
  linesEntered: number;
  newMembers: number;
  existingMembers: number;
  membersToRestore: number;
  requiringReview: number;
  invalidLines: number;
}

export interface BulkMemberExecutionResult {
  rows: BulkMemberRow[];
  added: number;
  restored: number;
  skipped: number;
  notProcessed: number;
  failed: number;
}

export interface BulkMemberDraft {
  input: string;
  rows: BulkMemberRow[];
  step: "entry" | "review";
  updatedAt: string;
}

function collapseSpaces(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function validName(firstName: string, lastName: string) {
  return (
    firstName.length > 0 &&
    firstName.length <= 100 &&
    lastName.length <= 100 &&
    /[\p{L}\p{M}]/u.test(firstName) &&
    !/[\u0000-\u001f<>[\]{}|\\]/u.test(`${firstName}${lastName}`)
  );
}

export function parseMemberLine(
  value: string,
): Pick<BulkMemberRow, "originalLine" | "firstName" | "lastName" | "error"> {
  const originalLine = value.trim();
  const normalizedLine = collapseSpaces(value);
  if (!normalizedLine) {
    return {
      originalLine,
      firstName: "",
      lastName: "",
      error: "This line is empty.",
    };
  }

  let firstName = "";
  let lastName = "";
  const commaIndex = normalizedLine.indexOf(",");
  if (commaIndex >= 0) {
    lastName = collapseSpaces(normalizedLine.slice(0, commaIndex));
    firstName = collapseSpaces(normalizedLine.slice(commaIndex + 1));
  } else {
    const [first, ...remaining] = normalizedLine.split(" ");
    firstName = first;
    lastName = remaining.join(" ");
  }

  const error = validName(firstName, lastName)
    ? undefined
    : "Enter a valid first name. Names may contain letters, spaces, apostrophes, hyphens, and accents.";
  return { originalLine, firstName, lastName, error };
}

export function classifyBulkMemberRow(
  row: Pick<
    BulkMemberRow,
    "id" | "originalLine" | "firstName" | "lastName"
  >,
  people: Person[],
  organizationId: string,
): BulkMemberRow {
  const firstName = collapseSpaces(row.firstName);
  const lastName = collapseSpaces(row.lastName);
  if (!validName(firstName, lastName)) {
    return {
      ...row,
      firstName,
      lastName,
      status: "invalid",
      decision: "review",
      matches: [],
      error:
        "Enter a valid first name. The last name may be blank for a single-word name.",
    };
  }
  const target = normalizeName(`${firstName} ${lastName}`);
  const matches = people.filter(
    (person) =>
      person.organizationId === organizationId &&
      person.personType === "member" &&
      normalizeName(person.displayName) === target,
  );
  if (matches.length > 1) {
    return {
      ...row,
      firstName,
      lastName,
      status: "ambiguous",
      decision: "review",
      matches,
      error: "Choose the correct existing member or create a separate person.",
    };
  }
  const match = matches[0];
  if (!match) {
    return {
      ...row,
      firstName,
      lastName,
      status: "ready",
      decision: "add",
      matches: [],
      error: undefined,
    };
  }
  if (match.deletedAt) {
    return {
      ...row,
      firstName,
      lastName,
      status: "deleted",
      decision: "restore",
      matches,
      selectedMatchId: match.id,
      error: undefined,
    };
  }
  if (!match.isActive) {
    return {
      ...row,
      firstName,
      lastName,
      status: "inactive",
      decision: "restore",
      matches,
      selectedMatchId: match.id,
      error: undefined,
    };
  }
  return {
    ...row,
    firstName,
    lastName,
    status: "existing",
    decision: "skip",
    matches,
    selectedMatchId: match.id,
    error: undefined,
  };
}

export function parseBulkMembers(
  input: string,
  people: Person[],
  organizationId: string,
) {
  return input
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, index }) => {
      const parsed = parseMemberLine(line);
      return classifyBulkMemberRow(
        {
          id: `bulk-${index}-${normalizeName(parsed.originalLine)}`,
          originalLine: parsed.originalLine,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
        },
        people,
        organizationId,
      );
    });
}

export function bulkMemberTotals(rows: BulkMemberRow[]): BulkMemberTotals {
  return {
    linesEntered: rows.length,
    newMembers: rows.filter(
      (row) =>
        row.status !== "processed" &&
        (row.decision === "add" || row.decision === "create_separate"),
    ).length,
    existingMembers: rows.filter((row) => row.decision === "skip").length,
    membersToRestore: rows.filter(
      (row) => row.status !== "processed" && row.decision === "restore",
    ).length,
    requiringReview: rows.filter(
      (row) => row.status === "ambiguous" && row.decision === "review",
    ).length,
    invalidLines: rows.filter((row) => row.status === "invalid").length,
  };
}

export function selectBulkMemberMatch(
  row: BulkMemberRow,
  memberId: string,
) {
  const match = row.matches.find((person) => person.id === memberId);
  if (!match) return row;
  return {
    ...row,
    selectedMatchId: memberId,
    status: match.deletedAt
      ? ("deleted" as const)
      : match.isActive
        ? ("existing" as const)
        : ("inactive" as const),
    decision: match.isActive ? ("skip" as const) : ("restore" as const),
    error: undefined,
  };
}

export function sortMembersByLastName(people: Person[]) {
  return [...people].sort((left, right) => {
    const leftLast = normalizeName(left.lastName || left.firstName);
    const rightLast = normalizeName(right.lastName || right.firstName);
    return (
      leftLast.localeCompare(rightLast) ||
      normalizeName(left.firstName).localeCompare(
        normalizeName(right.firstName),
      ) ||
      left.id.localeCompare(right.id)
    );
  });
}

export async function executeBulkMembers(
  user: UserContext,
  sourceRows: BulkMemberRow[],
  operations: {
    findMatches: typeof findExactMemberMatches;
    save: typeof saveMember;
    restore: typeof restoreMember;
  } = {
    findMatches: findExactMemberMatches,
    save: saveMember,
    restore: restoreMember,
  },
): Promise<BulkMemberExecutionResult> {
  if (user.role !== "admin" && user.role !== "attendance_taker") {
    throw new Error("You do not have permission to add church members.");
  }
  const rows = sourceRows.map((row) => ({ ...row }));
  let added = 0;
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.status === "processed") continue;
    if (row.decision === "skip") {
      rows[index] = {
        ...row,
        status: "processed",
        processedPersonId: row.selectedMatchId,
        error: undefined,
      };
      skipped += 1;
      continue;
    }
    if (
      row.status === "invalid" ||
      row.decision === "review" ||
      (row.decision === "restore" && !row.selectedMatchId)
    ) {
      continue;
    }

    try {
      if (row.decision === "restore") {
        const restoredMember = await operations.restore(
          user,
          row.selectedMatchId!,
        );
        rows[index] = {
          ...row,
          status: "processed",
          processedPersonId: restoredMember.id,
          error: undefined,
        };
        restored += 1;
        continue;
      }

      if (row.decision === "add") {
        const latestMatches = await operations.findMatches(
          user.organizationId,
          `${row.firstName} ${row.lastName}`,
        );
        if (latestMatches.length === 1) {
          const existing = latestMatches[0];
          if (existing.isActive && !existing.deletedAt) {
            rows[index] = {
              ...row,
              status: "processed",
              decision: "skip",
              selectedMatchId: existing.id,
              processedPersonId: existing.id,
              error: undefined,
            };
            skipped += 1;
            continue;
          }
          const restoredMember = await operations.restore(user, existing.id);
          rows[index] = {
            ...row,
            status: "processed",
            decision: "restore",
            selectedMatchId: restoredMember.id,
            processedPersonId: restoredMember.id,
            error: undefined,
          };
          restored += 1;
          continue;
        }
        if (latestMatches.length > 1) {
          rows[index] = {
            ...row,
            status: "ambiguous",
            decision: "review",
            matches: latestMatches,
            error:
              "Multiple matching members now exist. Choose one before retrying.",
          };
          continue;
        }
      }

      const member = await operations.save(user, {
        firstName: row.firstName,
        lastName: row.lastName,
        allowDuplicate: row.decision === "create_separate",
      });
      rows[index] = {
        ...row,
        status: "processed",
        processedPersonId: member.id,
        error: undefined,
      };
      added += 1;
    } catch (caught) {
      rows[index] = {
        ...row,
        status: "failed",
        error:
          caught instanceof Error
            ? caught.message
            : "This member could not be processed.",
      };
      failed += 1;
    }
  }

  const notProcessed = rows.filter(
    (row) =>
      row.status !== "processed" &&
      row.decision !== "skip" &&
      row.status !== "failed",
  ).length;
  return { rows, added, restored, skipped, failed, notProcessed };
}

function bulkDraftKey(user: UserContext) {
  return `church-attendance:bulk-members:${user.organizationId}:${user.userId}`;
}

export function saveBulkMemberDraft(
  user: UserContext,
  draft: BulkMemberDraft,
) {
  localStorage.setItem(bulkDraftKey(user), JSON.stringify(draft));
}

export function loadBulkMemberDraft(user: UserContext) {
  const stored = localStorage.getItem(bulkDraftKey(user));
  if (!stored) return undefined;
  try {
    return JSON.parse(stored) as BulkMemberDraft;
  } catch {
    return undefined;
  }
}

export function clearBulkMemberDraft(user: UserContext) {
  localStorage.removeItem(bulkDraftKey(user));
}
