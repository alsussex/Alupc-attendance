import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  DashboardView,
  emptyDashboardSnapshot,
  findPreviousEquivalentService,
  selectFeaturedService,
} from "@/components/dashboard/Dashboard";
import type {
  DashboardService,
  DashboardSnapshot,
} from "@/lib/dashboard/dashboard-data";

const now = new Date("2026-07-29T18:30:00");
const services: DashboardService[] = [
  {
    id: "service-today",
    title: "Wednesday Bible Study",
    serviceType: "Wednesday Bible Study",
    serviceDate: "2026-07-29",
    serviceTime: "19:00",
    status: "draft",
    attendanceTotal: 18,
    visitorCount: 2,
    sundaySchoolKidsCount: 3,
    childProgramLabel: "Children’s Church",
    updatedAt: "2026-07-29T18:15:00.000Z",
  },
  {
    id: "service-sunday",
    title: "Sunday Morning",
    serviceType: "Sunday Morning",
    serviceDate: "2026-07-26",
    serviceTime: "10:30",
    status: "completed",
    attendanceTotal: 52,
    visitorCount: 4,
    sundaySchoolKidsCount: 3,
    childProgramLabel: "Sunday School Kids",
    updatedAt: "2026-07-26T15:00:00.000Z",
  },
  {
    id: "service-last-wednesday",
    title: "Wednesday Bible Study",
    serviceType: "Wednesday Bible Study",
    serviceDate: "2026-07-22",
    serviceTime: "19:00",
    status: "completed",
    attendanceTotal: 41,
    visitorCount: 3,
    sundaySchoolKidsCount: 5,
    childProgramLabel: "Children’s Church",
    updatedAt: "2026-07-22T22:00:00.000Z",
  },
];

const snapshot: DashboardSnapshot = {
  churchName: "Abundant Life UPC",
  totalPeople: 64,
  servicesThisMonth: 7,
  attendanceThisMonth: 312,
  visitorsThisMonth: 14,
  averageAttendance: 45,
  draftService: services[0],
  services,
  activity: [],
};

afterEach(cleanup);

describe("dashboard service selection", () => {
  it("prioritizes today's open service, then the next scheduled service", () => {
    expect(selectFeaturedService(services, now)?.id).toBe("service-today");
    expect(
      selectFeaturedService(
        [
          services[1],
          { ...services[0], id: "future", serviceDate: "2026-08-02" },
        ],
        now,
      )?.id,
    ).toBe("future");
  });

  it("compares only the previous completed equivalent service", () => {
    expect(findPreviousEquivalentService(services[0], services)?.id).toBe(
      "service-last-wednesday",
    );
    const special = {
      ...services[0],
      id: "special",
      title: "Special Service",
      serviceType: "Special Service",
      customName: undefined,
    };
    expect(
      findPreviousEquivalentService(special, [special, ...services]),
    ).toBeUndefined();
  });
});

describe("dashboard presentation", () => {
  it("renders the real upcoming service as the primary operation", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator
        displayName="Robert"
        role="admin"
        currentDate={now}
      />,
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Good evening, Robert",
      }),
    ).toBeVisible();
    expect(screen.getByText("Admin")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Create new service" }),
    ).toHaveAttribute("href", "/services?new=1");
    expect(screen.getByText("Upcoming")).toBeVisible();
    expect(
      screen.getByText((_, element) =>
        element?.classList.contains("dashboard-service-when") ?? false,
      ),
    ).toHaveTextContent("7:00 PM");
    expect(screen.getByRole("link", { name: /Take attendance/ })).toHaveAttribute(
      "href",
      "/services?service=service-today",
    );
    const comparison = screen.getByLabelText("Attendance totals");
    expect(comparison).toHaveTextContent("Last Wednesday Bible Study41");
    expect(comparison).toHaveTextContent("Visitors3");
    expect(comparison).toHaveTextContent("Children’s Church5");
    expect(screen.queryByText("Quick actions")).not.toBeInTheDocument();
    expect(screen.queryByText("Attendance overview")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();
  });

  it("shows an in-progress service with compact live totals", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator={false}
        role="attendance_taker"
        currentDate={new Date("2026-07-29T20:00:00")}
      />,
    );
    expect(screen.getByText("In progress")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Continue attendance/ }),
    ).toHaveAttribute("href", "/services?service=service-today");
    const totals = screen.getByLabelText("Attendance totals");
    expect(totals).toHaveTextContent("Present18");
    expect(totals).toHaveTextContent("Visitors2");
    expect(totals).toHaveTextContent("Children’s Church3");
    expect(screen.getByText("Attendance Taker")).toBeVisible();
  });

  it("shows a completed summary and quietly surfaces the next service", () => {
    const completedToday = { ...services[0], status: "completed" as const };
    const next = {
      ...services[1],
      id: "next-service",
      serviceDate: "2026-08-02",
      status: "draft" as const,
    };
    render(
      <DashboardView
        snapshot={{
          ...snapshot,
          services: [completedToday, next, ...services.slice(1)],
        }}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: /View completed service/ }),
    ).toHaveAttribute("href", "/services?service=service-today");
    const nextRegion = screen.getByRole("region", { name: "Sunday Morning" });
    expect(within(nextRegion).getByText("Up next")).toBeVisible();
    expect(within(nextRegion).getByText(/August 2, 2026/)).toBeVisible();
    expect(within(nextRegion).getByRole("link", { name: /View schedule/ })).toHaveAttribute(
      "href",
      "/services",
    );
  });

  it("keeps recent services secondary, minimal, and directly navigable", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );
    const region = screen.getByRole("complementary", { name: "Recent services" });
    expect(within(region).getAllByRole("link")).toHaveLength(3);
    expect(
      within(region).getByRole("link", {
        name: "Open Sunday Morning, completed",
      }),
    ).toHaveAttribute("href", "/services?service=service-sunday");
    expect(within(region).getByText("52")).toBeVisible();
    expect(within(region).getAllByText("Completed")).toHaveLength(2);
  });

  it("provides a focused create-service state when no service exists", () => {
    render(
      <DashboardView
        snapshot={emptyDashboardSnapshot}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No upcoming service" }),
    ).toBeVisible();
    expect(screen.queryByText("Ready for the next service")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create service/ })).toHaveAttribute(
      "href",
      "/services?new=1",
    );
  });

  it("uses stable accessible skeletons while local data loads", () => {
    render(
      <DashboardView
        snapshot={emptyDashboardSnapshot}
        loading
        isAdministrator
        currentDate={now}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Loading current service" }),
    ).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Loading recent services" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "No upcoming service" }),
    ).not.toBeInTheDocument();
  });
});

describe("dashboard responsive styling", () => {
  const css = readFileSync(resolve("app/globals.css"), "utf8");

  it("uses one operational composition instead of statistic-card grids", () => {
    expect(css).toContain("--product-panel:");
    expect(css).toContain(".dashboard-home-layout {");
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(310px, 365px);",
    );
    expect(css).toContain(".dashboard-current-service {");
    expect(css).toContain(".dashboard-recent-services {");
  });

  it("moves recent services below the main area without horizontal overflow", () => {
    expect(css).toMatch(
      /@media \(max-width: 1050px\)[\s\S]*?\.dashboard-home-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
    expect(css).toMatch(
      /@media \(max-width: 680px\)[\s\S]*?\.dashboard-recent-list \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
  });

  it("honors reduced-motion accessibility preferences", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: .01ms !important");
  });
});
