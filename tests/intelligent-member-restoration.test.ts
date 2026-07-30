import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeName, type UserContext } from "@/lib/domain";
import {
  findExactMemberMatches,
  getServiceAttendance,
  listMemberCandidates,
  markMemberInactive,
  removeMember,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";

const organizationId = "20000000-0000-4000-8000-000000000310";
const otherOrganizationId = "20000000-0000-4000-8000-000000000311";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000310",
  organizationId,
  email: "leader@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000311",
  email: "volunteer@example.test",
  role: "attendance_taker",
};

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("intelligent member restoration", () => {
  it("normalizes capitalization and repeated surrounding or internal spaces", () => {
    expect(normalizeName("John Smith")).toBe("john smith");
    expect(normalizeName("john smith")).toBe("john smith");
    expect(normalizeName("JOHN SMITH")).toBe("john smith");
    expect(normalizeName("  John   Smith  ")).toBe("john smith");
  });

  it("finds an existing active member instead of preparing a duplicate", async () => {
    const member = await saveMember(admin, {
      firstName: "John",
      lastName: "Smith",
    });
    expect(
      await findExactMemberMatches(organizationId, "  JOHN   SMITH "),
    ).toEqual([member]);
  });

  it("restores an inactive member for an Attendance Taker using the same UUID", async () => {
    const member = await saveMember(admin, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    await markMemberInactive(admin, member.id);

    const restored = await restoreMember(taker, member.id);

    expect(restored).toMatchObject({
      id: member.id,
      createdAt: member.createdAt,
      isActive: true,
      inactiveAt: null,
      deletedAt: null,
    });
    expect(await listMemberCandidates(organizationId)).toHaveLength(1);
  });

  it("restores a soft-deleted member without inserting another people row", async () => {
    const member = await saveMember(admin, {
      firstName: "Taylor",
      lastName: "Brooks",
    });
    await removeMember(admin, member.id);

    const restored = await restoreMember(taker, member.id);

    expect(restored).toMatchObject({
      id: member.id,
      isActive: true,
      inactiveAt: null,
      deletedAt: null,
    });
    expect(await listMemberCandidates(organizationId)).toHaveLength(1);
  });

  it("preserves attendance history and relationships during restoration", async () => {
    const member = await saveMember(admin, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    const service = await saveService(admin, {
      serviceDate: "2026-07-27",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(admin, service.id, member.id, true);
    await markMemberInactive(admin, member.id);

    await restoreMember(taker, member.id);

    expect(await getServiceAttendance(service.id)).toEqual([
      expect.objectContaining({
        serviceId: service.id,
        personId: member.id,
        present: true,
      }),
    ]);
  });

  it("never returns a matching member from another organization", async () => {
    await saveMember(
      { ...admin, organizationId: otherOrganizationId },
      { firstName: "Jordan", lastName: "West" },
    );
    expect(
      await findExactMemberMatches(organizationId, "Jordan West"),
    ).toEqual([]);
  });

  it("returns every exact match so the interface must require a selection", async () => {
    await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
      allowDuplicate: true,
    });
    await saveMember(admin, {
      firstName: "Avery",
      lastName: "Stone",
      allowDuplicate: true,
    });
    expect(
      await findExactMemberMatches(organizationId, "avery stone"),
    ).toHaveLength(2);
  });

  it("queues one durable update for an offline restoration", async () => {
    const member = await saveMember(admin, {
      firstName: "Robin",
      lastName: "Field",
    });
    await markMemberInactive(admin, member.id);
    await restoreMember(taker, member.id);

    const mutations = (await getPendingChanges(organizationId)).filter(
      (mutation) =>
        mutation.table === "people" && mutation.recordId === member.id,
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0].payload).toMatchObject({
      id: member.id,
      is_active: true,
      inactive_at: null,
      deleted_at: null,
    });
  });

  it("uses safe restoration prompts in both member creation entry points", () => {
    const directory = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    const service = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    for (const source of [directory, service]) {
      expect(source).toContain("This member already exists.");
      expect(source).toContain(
        "An inactive member with this name already exists.",
      );
      expect(source).toContain(
        "A previously removed member with this name already exists.",
      );
      expect(source).toContain("Reactivate Existing Member");
      expect(source).toContain("Restore Existing Member");
    }
    expect(service).toContain("Multiple members share this name.");
    expect(service).not.toContain("Add another person");
  });

  it("keeps the database guard organization-scoped without merging old duplicates", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/202607300001_bulk_member_entry.sql"),
      "utf8",
    );
    expect(migration).toContain(
      "existing.organization_id = new.organization_id",
    );
    expect(migration).toContain("existing.person_type = 'member'");
    expect(migration).toContain("people_organization_normalized_name_idx");
    expect(migration).not.toMatch(/delete\s+from\s+public\.people/i);
    expect(migration).not.toMatch(/disable\s+row\s+level\s+security/i);
  });
});
