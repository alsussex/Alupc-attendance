import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Person, ServiceVisitor, UserContext } from "@/lib/domain";
import { listAuditEntries } from "@/lib/audit/audit-repository";
import {
  getServiceAttendance,
  saveMember,
  saveMemberPrivateDetails,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import {
  filterDirectoryMembers,
  sortDirectoryMembers,
} from "@/lib/people/member-directory";
import {
  findLikelyMemberMatches,
  memberSearchKey,
} from "@/lib/people/member-matching";
import {
  mergeMembers,
  previewMemberMerge,
} from "@/lib/people/member-merge";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000340";
const otherOrganizationId = "20000000-0000-4000-8000-000000000341";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000340",
  organizationId,
  email: "merge-admin@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000341",
  role: "attendance_taker",
};

async function withCreatedAt(person: Person, createdAt: string) {
  const updated = { ...person, createdAt };
  await (await getDatabase()).put("people", updated);
  return updated;
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("smart duplicate detection", () => {
  it("normalizes capitalization, repeated spaces, apostrophes, and hyphens", async () => {
    const member = await saveMember(admin, {
      firstName: "ANNE-MARIE",
      lastName: "O'BRIEN",
    });
    expect(member.displayName).toBe("Anne-Marie O'Brien");
    expect(memberSearchKey(" Anne  Marie O’Brien ")).toBe(
      memberSearchKey("Anne-Marie O'Brien"),
    );
    expect(
      findLikelyMemberMatches(
        [member],
        "anne marie obrien",
        organizationId,
      )[0],
    ).toMatchObject({ person: { id: member.id }, reason: "punctuation" });
  });

  it("detects likely spelling variants without crossing organizations", () => {
    const base: Person = {
      id: "30000000-0000-4000-8000-000000000340",
      organizationId,
      firstName: "Katherine",
      lastName: "Miller",
      displayName: "Katherine Miller",
      personType: "member",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    };
    expect(
      findLikelyMemberMatches(
        [base],
        "Kathrine Miller",
        organizationId,
      )[0].reason,
    ).toBe("similar");
    expect(
      findLikelyMemberMatches(
        [{ ...base, organizationId: otherOrganizationId }],
        "Kathrine Miller",
        organizationId,
      ),
    ).toHaveLength(0);
  });
});

describe("non-destructive member merge", () => {
  it("previews and preserves the oldest UUID, contacts, notes, history, and visitor links", async () => {
    const older = await withCreatedAt(
      await saveMember(admin, {
        firstName: "Jordan",
        lastName: "Meadow",
        phone: "+1 506 555 0101",
      }),
      "2024-01-01T00:00:00.000Z",
    );
    const newer = await withCreatedAt(
      await saveMember(admin, {
        firstName: "Jordon",
        lastName: "Meadow",
        email: "jordon@example.test",
      }),
      "2025-01-01T00:00:00.000Z",
    );
    await saveMemberPrivateDetails(admin, older.id, "Original note");
    await saveMemberPrivateDetails(admin, newer.id, "Duplicate note");
    const service = await saveService(admin, {
      serviceDate: "2026-07-30",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, newer.id, true);
    const visitor: ServiceVisitor = {
      id: "40000000-0000-4000-8000-000000000340",
      organizationId,
      serviceId: service.id,
      firstName: "Jordan",
      lastName: "Meadow",
      displayName: "Jordan Meadow",
      savedAsMember: true,
      memberPersonId: newer.id,
      createdAt: "2026-07-30T18:00:00.000Z",
      updatedAt: "2026-07-30T18:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    };
    await (await getDatabase()).put("visitors", visitor);

    const preview = await previewMemberMerge(admin, newer.id, older.id);
    expect(preview.survivor.id).toBe(older.id);
    expect(preview).toMatchObject({
      attendanceToMove: 1,
      visitorLinksToMove: 1,
      notesOutcome: "combined",
    });

    const result = await mergeMembers(admin, newer.id, older.id);
    expect(result.survivor).toMatchObject({
      id: older.id,
      email: "jordon@example.test",
      phone: "+1 506 555 0101",
      mergedFromIds: expect.arrayContaining([newer.id]),
    });
    expect(result.duplicate).toMatchObject({
      id: newer.id,
      mergedIntoId: older.id,
      isActive: false,
    });
    const attendance = await getServiceAttendance(service.id);
    expect(
      attendance.find((entry) => entry.personId === older.id)?.present,
    ).toBe(true);
    expect(
      attendance.find((entry) => entry.personId === newer.id)?.present,
    ).toBe(false);
    expect(
      (await (await getDatabase()).get("visitors", visitor.id))?.memberPersonId,
    ).toBe(older.id);
    expect(
      (await (await getDatabase()).get("memberPrivateDetails", older.id))?.notes,
    ).toContain("Original note");
    expect(
      (await (await getDatabase()).get("memberPrivateDetails", older.id))?.notes,
    ).toContain("Duplicate note");
  });

  it("deduplicates overlapping attendance without changing service history", async () => {
    const older = await withCreatedAt(
      await saveMember(admin, { firstName: "Alex", lastName: "Field" }),
      "2024-01-01T00:00:00.000Z",
    );
    const newer = await withCreatedAt(
      await saveMember(admin, { firstName: "Alec", lastName: "Field" }),
      "2025-01-01T00:00:00.000Z",
    );
    const service = await saveService(admin, {
      serviceDate: "2026-07-27",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, older.id, true);
    await setMemberAttendance(admin, service.id, newer.id, true);

    expect((await previewMemberMerge(admin, older.id, newer.id)).overlappingServices).toBe(1);
    await mergeMembers(admin, older.id, newer.id);
    const present = (await getServiceAttendance(service.id)).filter(
      (entry) => entry.present,
    );
    expect(present).toHaveLength(1);
    expect(present[0].personId).toBe(older.id);
  });

  it("preserves merged audit history and queues all offline updates", async () => {
    const older = await withCreatedAt(
      await saveMember(admin, { firstName: "Robin", lastName: "Brook" }),
      "2024-01-01T00:00:00.000Z",
    );
    const newer = await withCreatedAt(
      await saveMember(admin, { firstName: "Robyn", lastName: "Brook" }),
      "2025-01-01T00:00:00.000Z",
    );
    await mergeMembers(admin, older.id, newer.id);
    const history = await listAuditEntries(admin, {
      relatedEntityIds: [older.id, newer.id],
      limit: 50,
    });
    expect(history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["added", "merged", "merged_into"]),
    );
    const pending = await getPendingChanges(organizationId, true);
    expect(
      pending.some(
        (item) => item.table === "people" && item.recordId === older.id,
      ),
    ).toBe(true);
    expect(
      pending.some(
        (item) => item.table === "people" && item.recordId === newer.id,
      ),
    ).toBe(true);
  });

  it("rejects Attendance Takers and cross-organization member merges", async () => {
    const first = await saveMember(admin, {
      firstName: "First",
      lastName: "Member",
    });
    const second = await saveMember(admin, {
      firstName: "Second",
      lastName: "Member",
    });
    await expect(mergeMembers(taker, first.id, second.id)).rejects.toThrow(
      "administrator",
    );
    const other = {
      ...(await saveMember(admin, {
        firstName: "Other",
        lastName: "Church",
      })),
      organizationId: otherOrganizationId,
    };
    await (await getDatabase()).put("people", other);
    await expect(mergeMembers(admin, first.id, other.id)).rejects.toThrow(
      "your church",
    );
  });

  it("downloads merge and restoration metadata for cross-device reconciliation", () => {
    const merged = fromCloudRecord("people", {
      id: "30000000-0000-4000-8000-000000000349",
      organization_id: organizationId,
      first_name: "Jordan",
      last_name: "Meadow",
      display_name: "Jordan Meadow",
      person_type: "member",
      is_active: true,
      restored_at: "2026-07-30T10:00:00.000Z",
      merged_from_ids: [
        "30000000-0000-4000-8000-000000000348",
      ],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2026-07-30T10:00:00.000Z",
      created_by: admin.userId,
      updated_by: admin.userId,
    });
    expect("mergedFromIds" in merged && merged.mergedFromIds).toEqual([
      "30000000-0000-4000-8000-000000000348",
    ]);
    expect("restoredAt" in merged && merged.restoredAt).toBe(
      "2026-07-30T10:00:00.000Z",
    );
  });
});

describe("member directory utilities", () => {
  const people: Person[] = [
    {
      id: "one",
      organizationId,
      firstName: "Zara",
      lastName: "Adams",
      displayName: "Zara Adams",
      email: "zara@example.test",
      personType: "member",
      isActive: true,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    },
    {
      id: "two",
      organizationId,
      firstName: "Avery",
      lastName: "Brown",
      displayName: "Avery Brown",
      phone: "506-555-0102",
      personType: "member",
      isActive: true,
      restoredAt: "2026-07-28T00:00:00.000Z",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    },
  ];

  it("filters recent additions/restorations and searches contact fields", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    expect(
      filterDirectoryMembers(people, "recently_added", "", now).map(
        (person) => person.id,
      ),
    ).toEqual(["one"]);
    expect(
      filterDirectoryMembers(people, "recently_restored", "", now).map(
        (person) => person.id,
      ),
    ).toEqual(["two"]);
    expect(filterDirectoryMembers(people, "all", "555 0102", now)).toHaveLength(
      1,
    );
  });

  it("sorts by name, date added, last attendance, and attendance count", () => {
    const last = new Map([
      ["one", "2026-07-01"],
      ["two", "2026-07-29"],
    ]);
    const counts = new Map([
      ["one", 10],
      ["two", 20],
    ]);
    expect(sortDirectoryMembers(people, "name", last, counts)[0].id).toBe("one");
    expect(sortDirectoryMembers(people, "date_added", last, counts)[0].id).toBe(
      "one",
    );
    expect(
      sortDirectoryMembers(people, "last_attendance", last, counts)[0].id,
    ).toBe("two");
    expect(
      sortDirectoryMembers(people, "attendance_count", last, counts)[0].id,
    ).toBe("two");
  });

  it("provides merge preview UI and database defense in depth", () => {
    const peopleSource = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    const mergeSource = readFileSync(
      resolve("components/people/MemberMergeModal.tsx"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607300004_intelligent_member_management.sql",
      ),
      "utf8",
    );
    const stageOneSchema = readFileSync(
      resolve("supabase/migrations/202607290001_stage_one.sql"),
      "utf8",
    );
    const auditSchema = readFileSync(
      resolve(
        "supabase/migrations/202607290011_append_only_audit_log.sql",
      ),
      "utf8",
    );
    expect(peopleSource).toContain("Possible existing members");
    expect(mergeSource).toContain("Preview merge");
    expect(mergeSource).toContain("oldest member record always survives");
    expect(migration).toContain("Only administrators can merge church members");
    expect(migration).toContain("private.is_privileged_database_context()");
    expect(migration).toContain("person.id::text = history.entity_id");
    expect(stageOneSchema).toMatch(/create table public\.people \(\s+id uuid primary key/i);
    expect(stageOneSchema).toContain("unique (organization_id, id)");
    expect(auditSchema).toContain("entity_id text not null");
    expect(migration).toContain(
      "foreign key (organization_id, merged_into_id)",
    );
    expect(migration).not.toMatch(/disable row level security/i);
  });
});
