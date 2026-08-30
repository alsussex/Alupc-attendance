import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Person, UserContext } from "@/lib/domain";
import {
  adjustUnnamedVisitorCount,
  listServices,
  saveService,
  setUnnamedVisitorCount,
} from "@/lib/repositories/attendance-repository";
import {
  attendancePresentCounts,
  attendanceVisitorBreakdown,
  filterAttendanceMembers,
} from "@/lib/services/attendance-view";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord, toCloudRecord } from "@/lib/sync/serialization";

const organizationId = "20000000-0000-4000-8000-000000000140";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000140",
  organizationId,
  email: "volunteer@example.test",
  role: "attendance_taker",
};

const source = readFileSync(
  resolve("components/services/ServiceManager.tsx"),
  "utf8",
);
const styles = readFileSync(resolve("app/globals.css"), "utf8");

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("attendance people tabs", () => {
  it("selects Members by default and renders only the active panel", () => {
    expect(source).toContain(
      'useState<AttendanceTab>("members")',
    );
    expect(source).toContain('attendanceTab === "members" &&');
    expect(source).toContain('attendanceTab === "visitors" &&');
    expect(source).toContain('id="attendance-members-panel"');
    expect(source).toContain('id="attendance-visitors-panel"');
  });

  it("uses accessible tab semantics and keyboard arrow navigation", () => {
    expect(source).toContain('role="tablist"');
    expect(source.match(/role="tab"/g)).toHaveLength(3);
    expect(source.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(source).toContain('aria-selected={attendanceTab === "members"}');
    expect(source).toContain('aria-selected={attendanceTab === "visitors"}');
    expect(source).toContain('event.key !== "ArrowRight"');
    expect(source).toContain('event.key !== "ArrowLeft"');
  });

  it("keeps separate search and scroll state for each tab", () => {
    expect(source).toContain("memberSearch");
    expect(source).toContain("visitorSearch");
    expect(source).toContain("tabScrollPositions");
    expect(source).toContain("pendingTabScrollRestore");
    expect(source).toContain("useLayoutEffect(() =>");
    expect(source).toContain("tabScrollServiceId.current !== serviceId");
    expect(source).toContain("tabScrollPositions.current[tab] ?? currentPosition");
    expect(source).toContain("focus({ preventScroll: true })");
    expect(source).not.toContain("window.requestAnimationFrame");
    expect(source).toContain('openService(current, { resetView: false })');
  });

  it("shows the combined visitor-workspace total and each contributing count", () => {
    const visitor = {
      id: "40000000-0000-4000-8000-000000000141",
      organizationId,
      serviceId: "30000000-0000-4000-8000-000000000141",
      firstName: "Jordan",
      lastName: "",
      displayName: "Jordan",
      savedAsMember: false,
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
      createdBy: user.userId,
      updatedBy: user.userId,
    };

    expect(attendanceVisitorBreakdown([visitor], 2, 3)).toEqual({
      named: 1,
      unnamed: 2,
      children: 3,
      total: 6,
    });
    expect(source).toContain("visitorBreakdown.total} total");
    expect(source).toContain("visitorBreakdown.named} named");
    expect(source).toContain("visitorBreakdown.unnamed} unnamed");
    expect(source).toContain("visitorBreakdown.children} {childProgram.label}");
  });

  it("keeps visitor-only and member-only controls in their corresponding panels", () => {
    const memberPanel = source.slice(
      source.indexOf('{attendanceTab === "members" &&'),
      source.lastIndexOf('{attendanceTab === "visitors" &&'),
    );
    const visitorPanel = source.slice(
      source.lastIndexOf('{attendanceTab === "visitors" &&'),
      source.indexOf('className="sticky-actions'),
    );
    expect(memberPanel).toContain("+ Add Member");
    expect(memberPanel).toContain('aria-label="Filter members"');
    expect(memberPanel).not.toContain("+ Add Visitor");
    expect(visitorPanel).toContain("+ Add Visitor");
    expect(visitorPanel).toContain("Unnamed Visitors");
    expect(visitorPanel).not.toContain("Mark all absent");
  });
});

describe("responsive attendance cards", () => {
  it("uses an auto-fit grid with a readable 220 pixel minimum member card", () => {
    expect(styles).toContain(
      "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
    );
    expect(styles).toContain(".member-card-grid");
    expect(styles).toContain("min-width: 0");
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  it("supports full-card checkbox activation and a visible selected state", () => {
    expect(source).toContain('"attendance-person-card"');
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('checked ? "present" : "absent"');
    expect(source).toContain("Mark Present");
    expect(styles).toContain(".attendance-person-card.selected");
    expect(styles).toContain("background: var(--success-bg)");
    expect(styles).toContain(".attendance-person-card:focus-within");
  });

  it("keeps visitor edit and remove controls isolated from other actions", () => {
    expect(source.match(/event\.stopPropagation\(\)/g)?.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(source).toContain("aria-label={`Edit ${visitor.displayName}`}");
    expect(source).toContain("aria-label={`Remove ${visitor.displayName}`}");
  });

  it("matches a typed returning visitor without replacing the name fields with a picker", () => {
    expect(source).toContain("findReturningVisitorMatches(");
    expect(source).toContain("Returning visitor found");
    expect(source).toContain("previous visit");
    expect(source).toContain("Add returning visit");
    expect(source).toContain("This is someone else");
    expect(source).toContain("More than one returning visitor has this name.");
    expect(source).toContain("The app will never merge people by name alone.");
    expect(source).toContain("returningVisitorPersonId: selectedMatch?.visitorPersonId");
  });

  it("filters a 250-member grid without duplicates or blank placeholders", () => {
    const members: Person[] = Array.from({ length: 250 }, (_, index) => ({
      id: `member-${index}`,
      organizationId,
      firstName: index % 2 ? "Avery" : "Morgan",
      lastName: `Person ${index}`,
      displayName: `${index % 2 ? "Avery" : "Morgan"} Person ${index}`,
      personType: "member",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: user.userId,
      updatedBy: user.userId,
    }));
    const present = new Set(members.slice(0, 100).map((member) => member.id));
    expect(filterAttendanceMembers(members, present, "present", "")).toHaveLength(
      100,
    );
    expect(
      filterAttendanceMembers(members, present, "absent", "Morgan"),
    ).toHaveLength(75);
    expect(
      new Set(
        filterAttendanceMembers(members, present, "all", "").map(
          (member) => member.id,
        ),
      ).size,
    ).toBe(250);
  });
});

describe("unnamed visitor local-first synchronization", () => {
  it("stores a non-negative count on the service and queues the same UUID", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-09-27",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await (await getDatabase()).clear("syncQueue");
    const updated = await setUnnamedVisitorCount(user, service.id, 3);
    expect(updated.unnamedVisitorCount).toBe(3);
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      table: "services",
      recordId: service.id,
      payload: { unnamed_visitor_count: 3 },
    });

    await setUnnamedVisitorCount(user, service.id, -8);
    expect((await listServices(organizationId))[0].unnamedVisitorCount).toBe(0);
  });

  it("survives browser restart and is included in combined attendance totals", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-10-04",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setUnnamedVisitorCount(user, service.id, 4);
    await closeLocalDatabaseConnection();
    expect((await listServices(organizationId))[0].unnamedVisitorCount).toBe(4);
    expect(attendancePresentCounts(new Set(["member"]), [], true, 4)).toEqual({
      total: 5,
      members: 1,
      visitors: 4,
    });
  });

  it("preserves rapid unnamed visitor increments without lost updates", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-10-05",
      serviceType: "Special Service",
      status: "draft",
    });
    await Promise.all([
      adjustUnnamedVisitorCount(user, service.id, 1),
      adjustUnnamedVisitorCount(user, service.id, 1),
      adjustUnnamedVisitorCount(user, service.id, 1),
    ]);
    expect((await listServices(organizationId))[0].unnamedVisitorCount).toBe(3);
    expect(
      (await getPendingChanges(organizationId)).filter(
        (item) => item.table === "services" && item.recordId === service.id,
      ),
    ).toHaveLength(1);
  });

  it("round-trips the count through cloud serialization", () => {
    const cloud = {
      id: "40000000-0000-4000-8000-000000000140",
      organization_id: organizationId,
      service_date: "2026-10-11",
      service_type: "Sunday Evening",
      service_time: null,
      custom_name: null,
      status: "draft",
      unnamed_visitor_count: 7,
      is_archived: false,
      deleted_at: null,
      version: 2,
      created_by: user.userId,
      updated_by: user.userId,
      created_at: "2026-10-11T12:00:00.000Z",
      updated_at: "2026-10-11T12:00:00.000Z",
    };
    const local = fromCloudRecord("services", cloud);
    expect(local).toMatchObject({ unnamedVisitorCount: 7 });
    expect(toCloudRecord(local)).toMatchObject({ unnamed_visitor_count: 7 });
  });

  it("adds the constrained count without changing service RLS", () => {
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607290010_unnamed_visitor_count.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("add column if not exists unnamed_visitor_count");
    expect(migration).toContain("unnamed_visitor_count >= 0");
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/create policy/i);
  });
});
