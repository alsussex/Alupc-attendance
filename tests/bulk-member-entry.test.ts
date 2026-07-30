import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Person,
  PullTable,
  UserContext,
} from "@/lib/domain";
import {
  bulkMemberTotals,
  classifyBulkMemberRow,
  clearBulkMemberDraft,
  executeBulkMembers,
  loadBulkMemberDraft,
  parseBulkMembers,
  parseMemberLine,
  saveBulkMemberDraft,
  selectBulkMemberMatch,
  sortMembersByLastName,
} from "@/lib/people/bulk-member-entry";
import {
  getServiceAttendance,
  listActiveMembers,
  listMemberCandidates,
  markMemberInactive,
  removeMember,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";

const organizationId = "20000000-0000-4000-8000-000000000210";
const otherOrganizationId = "20000000-0000-4000-8000-000000000211";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000210",
  organizationId,
  email: "leader@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000211",
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
  localStorage.clear();
});

describe("bulk member parsing and preview", () => {
  it("parses multiple lines, ignores blanks, and normalizes extra spaces", () => {
    const rows = parseBulkMembers(
      "  John   Smith  \n\n Mary   Jane Brown \nPeter",
      [],
      organizationId,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map(({ firstName, lastName }) => [firstName, lastName])).toEqual([
      ["John", "Smith"],
      ["Mary", "Jane Brown"],
      ["Peter", ""],
    ]);
  });

  it("preserves apostrophes, hyphens, accents, and comma-formatted names", () => {
    expect(parseMemberLine("Anne-Marie O'Brien")).toMatchObject({
      firstName: "Anne-Marie",
      lastName: "O'Brien",
      error: undefined,
    });
    expect(parseMemberLine("García-López, Élodie")).toMatchObject({
      firstName: "Élodie",
      lastName: "García-López",
      error: undefined,
    });
  });

  it("shows preview classifications and recalculates after name correction", () => {
    const active = person({
      id: "30000000-0000-4000-8000-000000000210",
      firstName: "Avery",
      lastName: "Stone",
    });
    const [existing, ready] = parseBulkMembers(
      " aVeRy   sToNe \nWrong Name",
      [active],
      organizationId,
    );
    expect(existing.status).toBe("existing");
    expect(ready.status).toBe("ready");
    const corrected = classifyBulkMemberRow(
      { ...ready, firstName: "Robin", lastName: "" },
      [active],
      organizationId,
    );
    expect(corrected).toMatchObject({
      firstName: "Robin",
      lastName: "",
      status: "ready",
    });
    expect(bulkMemberTotals([existing, corrected])).toMatchObject({
      linesEntered: 2,
      newMembers: 1,
      existingMembers: 1,
    });
  });

  it("requires selection for multiple exact matches or an explicit separate record", () => {
    const first = person({
      id: "30000000-0000-4000-8000-000000000212",
      firstName: "Jordan",
      lastName: "West",
      isActive: false,
    });
    const second = person({
      id: "30000000-0000-4000-8000-000000000213",
      firstName: "Jordan",
      lastName: "West",
      deletedAt: "2026-07-01T00:00:00.000Z",
      isActive: false,
    });
    const [row] = parseBulkMembers(
      "Jordan West",
      [first, second],
      organizationId,
    );
    expect(row).toMatchObject({
      status: "ambiguous",
      decision: "review",
    });
    expect(selectBulkMemberMatch(row, second.id)).toMatchObject({
      status: "deleted",
      decision: "restore",
      selectedMatchId: second.id,
    });
  });
});

describe("bulk member execution", () => {
  it("creates multiple members and never duplicates an existing active member", async () => {
    await saveMember(taker, { firstName: "Avery", lastName: "Stone" });
    const rows = parseBulkMembers(
      "Avery Stone\nMorgan Lane\nRiley Green",
      await listMemberCandidates(organizationId),
      organizationId,
    );
    const result = await executeBulkMembers(taker, rows);
    expect(result).toMatchObject({ added: 2, skipped: 1, failed: 0 });
    expect(
      (await listActiveMembers(organizationId)).map((member) =>
        member.displayName,
      ),
    ).toEqual(["Avery Stone", "Morgan Lane", "Riley Green"]);
  });

  it("restores inactive and soft-deleted members with UUID and history intact", async () => {
    const inactive = await saveMember(admin, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    const removed = await saveMember(admin, {
      firstName: "Taylor",
      lastName: "Brooks",
    });
    const service = await saveService(admin, {
      serviceDate: "2026-07-27",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, inactive.id, true);
    await markMemberInactive(admin, inactive.id);
    await removeMember(admin, removed.id);

    const rows = parseBulkMembers(
      "casey harbor\nTAYLOR BROOKS",
      await listMemberCandidates(organizationId),
      organizationId,
    );
    const result = await executeBulkMembers(taker, rows);
    expect(result).toMatchObject({ added: 0, restored: 2 });
    const restored = await listActiveMembers(organizationId);
    expect(restored.map((member) => member.id)).toEqual(
      expect.arrayContaining([inactive.id, removed.id]),
    );
    expect((await getServiceAttendance(service.id))[0]).toMatchObject({
      personId: inactive.id,
      present: true,
    });
  });

  it("does not merge another organization and enforces authorized roles", async () => {
    const other = person({
      id: "30000000-0000-4000-8000-000000000214",
      organizationId: otherOrganizationId,
      firstName: "Morgan",
      lastName: "Lane",
    });
    const [row] = parseBulkMembers(
      "Morgan Lane",
      [other],
      organizationId,
    );
    expect(row.status).toBe("ready");
    await expect(
      executeBulkMembers(
        { ...taker, role: "viewer" } as unknown as UserContext,
        [row],
      ),
    ).rejects.toThrow("permission");
  });

  it("retries only failed rows without duplicating successful rows", async () => {
    const rows = parseBulkMembers(
      "Avery Stone\nMorgan Lane",
      [],
      organizationId,
    );
    let failMorgan = true;
    const first = await executeBulkMembers(taker, rows, {
      findMatches: async () => [],
      restore: restoreMember,
      save: async (user, input) => {
        if (input.firstName === "Morgan" && failMorgan) {
          throw new Error("Temporary local failure");
        }
        return saveMember(user, input);
      },
    });
    expect(first).toMatchObject({ added: 1, failed: 1 });
    failMorgan = false;
    const retried = await executeBulkMembers(taker, first.rows);
    expect(retried).toMatchObject({ added: 1, failed: 0 });
    expect(await listActiveMembers(organizationId)).toHaveLength(2);
  });

  it("queues offline additions and restorations with stable IDs", async () => {
    const member = await saveMember(admin, {
      firstName: "Robin",
      lastName: "Field",
    });
    await markMemberInactive(admin, member.id);
    await uploadPendingChanges(organizationId, acceptingTarget());
    const rows = parseBulkMembers(
      "Robin Field\nJamie River",
      await listMemberCandidates(organizationId),
      organizationId,
    );
    await executeBulkMembers(taker, rows);
    const peopleMutations = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "people",
    );
    expect(peopleMutations).toHaveLength(2);
    expect(peopleMutations.find((item) => item.recordId === member.id)).toBeDefined();
    expect(new Set(peopleMutations.map((item) => item.recordId)).size).toBe(2);
  });

  it("uploads once and reconciles the same members on a fresh device", async () => {
    const rows = parseBulkMembers(
      "Alex Meadow\nRobin Field",
      [],
      organizationId,
    );
    await executeBulkMembers(taker, rows);
    const cloud = new Map<string, Record<string, unknown>[]>();
    const target: UploadTarget = {
      async upsert(table, payload) {
        const current = cloud.get(table) ?? [];
        cloud.set(
          table,
          [...current.filter((row) => row.id !== payload.id), payload],
        );
        return { version: 1 };
      },
    };
    await uploadPendingChanges(organizationId, target);
    await clearLocalDatabase();
    const source: PullSource = {
      async fetchPage(table: PullTable) {
        return { rows: cloud.get(table) ?? [], hasMore: false };
      },
    };
    await pullOrganizationData(taker, source);
    expect(
      (await listActiveMembers(organizationId)).map((member) => member.displayName),
    ).toEqual(["Alex Meadow", "Robin Field"]);
  });
});

describe("sorting, persistence, and security contracts", () => {
  it("sorts by last name then first name and handles blank last names", () => {
    const sorted = sortMembersByLastName([
      person({ id: "1", firstName: "Sarah", lastName: "Brown" }),
      person({ id: "2", firstName: "Peter", lastName: "" }),
      person({ id: "3", firstName: "Mary", lastName: "Adams" }),
      person({ id: "4", firstName: "John", lastName: "Brown" }),
    ]);
    expect(sorted.map((member) => member.displayName)).toEqual([
      "Mary Adams",
      "John Brown",
      "Sarah Brown",
      "Peter",
    ]);
  });

  it("persists an unfinished bulk draft through reload and clears it explicitly", () => {
    const rows = parseBulkMembers("Avery Stone", [], organizationId);
    saveBulkMemberDraft(taker, {
      input: "Avery Stone",
      rows,
      step: "review",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(loadBulkMemberDraft(taker)).toMatchObject({
      input: "Avery Stone",
      step: "review",
    });
    clearBulkMemberDraft(taker);
    expect(loadBulkMemberDraft(taker)).toBeUndefined();
  });

  it("includes preview, correction, responsive UI, and hardened database rules", () => {
    const component = readFileSync(
      resolve("components/people/BulkMemberEntryModal.tsx"),
      "utf8",
    );
    const directory = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    const migration = readFileSync(
      resolve("supabase/migrations/202607300001_bulk_member_entry.sql"),
      "utf8",
    );
    expect(directory).toContain("Add Multiple Members");
    expect(component).toContain("Review Members");
    expect(component).toContain('role="table"');
    expect(component).toContain("Create separate person");
    expect(migration).toContain("normalized_name");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("duplicate_name_allowed");
    expect(migration).toContain("safe_restoration");
    expect(migration).not.toMatch(/disable row level security/i);
  });
});

function person(
  input: Partial<Person> & Pick<Person, "id" | "firstName" | "lastName">,
): Person {
  const timestamp = "2026-07-01T12:00:00.000Z";
  return {
    id: input.id,
    organizationId: input.organizationId ?? organizationId,
    firstName: input.firstName,
    lastName: input.lastName,
    displayName: `${input.firstName} ${input.lastName}`.trim(),
    personType: "member",
    isActive: input.isActive ?? true,
    inactiveAt: input.inactiveAt,
    deletedAt: input.deletedAt,
    duplicateNameAllowed: input.duplicateNameAllowed ?? false,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    createdBy: input.createdBy ?? admin.userId,
    updatedBy: input.updatedBy ?? admin.userId,
  };
}

function acceptingTarget(): UploadTarget {
  return {
    upsert: vi.fn(async () => ({ version: 1 })),
  };
}
