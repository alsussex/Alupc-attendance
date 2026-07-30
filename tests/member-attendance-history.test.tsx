import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemberAttendanceHistory } from "@/components/people/MemberAttendanceHistory";
import type {
  AttendanceRecord,
  ChurchService,
} from "@/lib/domain";
import {
  buildMemberAttendanceHistory,
  filterMemberAttendanceHistory,
  serviceTypeAttendanceTotals,
  summarizeMemberAttendance,
} from "@/lib/people/attendance-history";
import { getDatabase } from "@/lib/storage/database";
import { getOrganizationService } from "@/lib/repositories/attendance-repository";
import { announceDataChanged } from "@/lib/storage/data-events";

afterEach(cleanup);

const organizationId = "10000000-0000-4000-8000-000000000001";
const personId = "20000000-0000-4000-8000-000000000001";

function service(
  id: string,
  serviceDate: string,
  serviceType = "Sunday Morning",
): ChurchService {
  return {
    id,
    organizationId,
    serviceDate,
    serviceType,
    serviceTime: "10:30",
    status: "completed",
    isArchived: false,
    createdAt: `${serviceDate}T13:30:00.000Z`,
    updatedAt: `${serviceDate}T15:00:00.000Z`,
    createdBy: "admin",
    updatedBy: "admin",
  };
}

function attendance(
  serviceId: string,
  present = true,
  overrides: Partial<AttendanceRecord> = {},
): AttendanceRecord {
  return {
    id: `${serviceId}:${personId}`,
    organizationId,
    serviceId,
    personId,
    present,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "admin",
    updatedBy: "admin",
    ...overrides,
  };
}

describe("member attendance history calculations", () => {
  const services = [
    service("service-july-1", "2026-07-27"),
    service("service-july-2", "2026-07-20", "Sunday Evening"),
    service("service-june", "2026-06-15"),
    service("service-old", "2025-12-28", "Special Service"),
  ];
  const entries = buildMemberAttendanceHistory(
    services.map((item) => attendance(item.id)),
    services,
    organizationId,
    personId,
  );

  it("calculates last attended, all-time, monthly, and yearly totals", () => {
    expect(
      summarizeMemberAttendance(entries, new Date(2026, 6, 30)),
    ).toEqual({
      lastAttendedDate: "2026-07-27",
      totalServices: 4,
      thisMonth: 2,
      thisYear: 3,
    });
  });

  it("filters by year, month, last 30 days, and service type", () => {
    const now = new Date(2026, 6, 30);
    expect(filterMemberAttendanceHistory(entries, "year", "all", now)).toHaveLength(3);
    expect(filterMemberAttendanceHistory(entries, "month", "all", now)).toHaveLength(2);
    expect(
      filterMemberAttendanceHistory(entries, "last_30_days", "all", now),
    ).toHaveLength(2);
    expect(
      filterMemberAttendanceHistory(
        entries,
        "all",
        "Sunday Evening",
        now,
      ),
    ).toHaveLength(1);
  });

  it("calculates service-type totals and excludes absent or unrelated records", () => {
    const history = buildMemberAttendanceHistory(
      [
        ...services.map((item) => attendance(item.id)),
        attendance("absent-service", false),
        attendance("cross-organization", true, {
          organizationId: "another-organization",
        }),
      ],
      [...services, service("absent-service", "2026-07-13")],
      organizationId,
      personId,
    );
    expect(serviceTypeAttendanceTotals(history)).toEqual([
      { serviceType: "Sunday Morning", total: 2 },
      { serviceType: "Special Service", total: 1 },
      { serviceType: "Sunday Evening", total: 1 },
    ]);
  });
});

describe("member attendance history interface", () => {
  it("loads from IndexedDB, links to services, filters, and paginates", async () => {
    const database = await getDatabase();
    const uniqueOrganization = crypto.randomUUID();
    const uniquePerson = crypto.randomUUID();
    const services = Array.from({ length: 22 }, (_, index) => {
      const day = String(28 - index).padStart(2, "0");
      return {
        ...service(crypto.randomUUID(), `2026-07-${day}`),
        organizationId: uniqueOrganization,
        serviceType: index % 2 ? "Sunday Evening" : "Sunday Morning",
      };
    });
    await Promise.all(
      services.flatMap((item) => [
        database.put("services", item),
        database.put("attendance", {
          ...attendance(item.id),
          id: `${item.id}:${uniquePerson}`,
          organizationId: uniqueOrganization,
          personId: uniquePerson,
        }),
      ]),
    );

    render(
      <MemberAttendanceHistory
        organizationId={uniqueOrganization}
        personId={uniquePerson}
        memberName="Taylor Example"
        currentDate={new Date(2026, 6, 30)}
      />,
    );

    const summary = await screen.findByRole("region", {
      name: "Taylor Example attendance summary",
    });
    expect(
      within(summary).getByRole("article", {
        name: "Total services attended: 22",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(20);
    const firstLink = screen.getAllByRole("link")[0];
    expect(firstLink).toHaveAttribute(
      "href",
      `/services?service=${encodeURIComponent(services[0].id)}`,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Load more attendance" }),
    );
    expect(screen.getAllByRole("link")).toHaveLength(22);

    fireEvent.change(screen.getByLabelText("Service type"), {
      target: { value: "Sunday Evening" },
    });
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(11));

    const synchronizedService = {
      ...service(crypto.randomUUID(), "2026-07-29", "Sunday Evening"),
      organizationId: uniqueOrganization,
    };
    await database.put("services", synchronizedService);
    await database.put("attendance", {
      ...attendance(synchronizedService.id),
      id: `${synchronizedService.id}:${uniquePerson}`,
      organizationId: uniqueOrganization,
      personId: uniquePerson,
    });
    announceDataChanged();
    await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(12));
  });

  it("exposes an accessible Attendance History tab on every member profile", () => {
    const source = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    expect(source).toContain("Attendance History");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain("MemberAttendanceHistory");
    expect(source).toContain("ArrowRight");
  });

  it("opens organization-scoped archived history services without exposing another organization", async () => {
    const database = await getDatabase();
    const scopedOrganization = crypto.randomUUID();
    const archived = {
      ...service(crypto.randomUUID(), "2026-05-10"),
      organizationId: scopedOrganization,
      isArchived: true,
    };
    await database.put("services", archived);
    expect(
      await getOrganizationService(scopedOrganization, archived.id),
    ).toEqual(archived);
    expect(
      await getOrganizationService("another-organization", archived.id),
    ).toBeUndefined();
  });
});
