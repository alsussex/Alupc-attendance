import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  DashboardView,
  emptyDashboardSnapshot,
} from "@/components/dashboard/Dashboard";
import type { DashboardSnapshot } from "@/lib/dashboard/dashboard-data";

const now = new Date("2026-07-29T18:30:00");
const snapshot: DashboardSnapshot = {
  churchName: "Abundant Life UPC",
  totalPeople: 64,
  servicesThisMonth: 7,
  attendanceThisMonth: 312,
  visitorsThisMonth: 14,
  averageAttendance: 45,
  draftService: {
    id: "service-today",
    title: "Wednesday Bible Study",
    serviceDate: "2026-07-29",
    serviceTime: "19:00",
    status: "draft",
    attendanceTotal: 18,
    visitorCount: 2,
    updatedAt: "2026-07-29T18:15:00.000Z",
  },
  services: [
    {
      id: "service-today",
      title: "Wednesday Bible Study",
      serviceDate: "2026-07-29",
      serviceTime: "19:00",
      status: "draft",
      attendanceTotal: 18,
      visitorCount: 2,
      updatedAt: "2026-07-29T18:15:00.000Z",
    },
    {
      id: "service-sunday",
      title: "Sunday Morning",
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
      id: "service-june",
      title: "Special Service",
      serviceDate: "2026-06-21",
      status: "completed",
      attendanceTotal: 48,
      visitorCount: 5,
      updatedAt: "2026-06-21T15:00:00.000Z",
    },
  ],
  activity: [
    {
      id: "activity-one",
      type: "attendance",
      message: "Recorded attendance for Wednesday Bible Study",
      timestamp: "2026-07-29T18:15:00.000Z",
    },
    {
      id: "activity-two",
      type: "visitor",
      message: "Added visitor Morgan Lane",
      timestamp: "2026-07-29T18:00:00.000Z",
    },
  ],
};

afterEach(cleanup);

describe("dashboard presentation", () => {
  it("renders a clear hero, open quick actions, and an integrated overview", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Abundant Life UPC Attendance",
      }),
    ).toBeVisible();
    expect(screen.getByText("Good evening")).toBeVisible();
    expect(screen.getByText("Today’s service")).toBeVisible();
    expect(
      screen
        .getAllByRole("link", { name: /^New service/ })
        .every((link) => link.getAttribute("href") === "/services?new=1"),
    ).toBe(true);
    expect(screen.getByRole("link", { name: /Members/ })).toHaveAttribute(
      "href",
      "/people",
    );
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("link", { name: /Reports/ })).toHaveAttribute(
      "href",
      "/reports",
    );
    expect(
      within(
        screen.getByRole("region", { name: "Attendance overview" }),
      ).getAllByRole("article"),
    ).toHaveLength(6);
    expect(
      screen.getByRole("navigation", { name: "Dashboard shortcuts" }),
    ).toHaveClass("dashboard-action-list");
  });

  it("keeps role-aware actions and the draft resume workflow intact", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator={false}
        currentDate={now}
      />,
    );
    expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Resume attendance for Wednesday Bible Study",
      }),
    ).toHaveAttribute("href", "/services?service=service-today");
    expect(screen.getByRole("link", { name: /Visitors/ })).toHaveAttribute(
      "href",
      "/services?service=service-today&visitor=1",
    );
  });

  it("shows open service rows with status, totals, and update time", () => {
    render(
      <DashboardView
        snapshot={snapshot}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );

    const service = screen.getByRole("link", {
      name: "Open Sunday Morning, completed",
    });
    expect(service).toHaveAttribute(
      "href",
      "/services?service=service-sunday",
    );
    expect(within(service).getByText("Completed")).toBeVisible();
    expect(within(service).getByText("52")).toBeVisible();
    expect(within(service).getByText("4")).toBeVisible();
    expect(within(service).getByText("3")).toBeVisible();
    expect(within(service).getByText("Sunday School Kids")).toBeVisible();
    expect(within(service).getByText(/Updated/)).toBeVisible();

    const juneToggle = screen.getByRole("button", { name: /June 2026/ });
    expect(juneToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(juneToggle);
    expect(juneToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("link", {
        name: "Open Special Service, completed",
      }),
    ).toBeVisible();
  });

  it("shows friendly service and activity empty states", () => {
    render(
      <DashboardView
        snapshot={emptyDashboardSnapshot}
        loading={false}
        isAdministrator
        currentDate={now}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No services yet" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Create your first service to begin tracking attendance.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Create first service" }),
    ).toHaveAttribute("href", "/services?new=1");
    expect(screen.getByText("You’re ready to begin")).toBeVisible();
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
      screen.getByRole("status", { name: "Loading church dashboard" }),
    ).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Loading recent services" }),
    ).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Loading recent activity" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "No services yet" }),
    ).not.toBeInTheDocument();
  });
});

describe("dashboard responsive styling", () => {
  const css = readFileSync(resolve("app/globals.css"), "utf8");

  it("uses fluid grids and prevents narrow cards from overflowing", () => {
    expect(css).toContain(
      ".dashboard-action-grid {\n  display: grid;\n  grid-template-columns: repeat(6, minmax(0, 1fr));",
    );
    expect(css).toContain(
      ".dashboard-metric-grid {\n  display: grid;\n  grid-template-columns: repeat(6, minmax(0, 1fr));",
    );
    expect(css).toContain(".dashboard-action-card {\n  position: relative;\n  min-width: 0;");
    expect(css).toContain(".dashboard-service-card {\n  min-width: 0;");
  });

  it("provides desktop, tablet, mobile, and extra-narrow layouts", () => {
    expect(css).toContain("@media (max-width: 1180px)");
    expect(css).toContain("@media (max-width: 820px)");
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain("@media (max-width: 360px)");
    expect(css).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.dashboard-hero \{[\s\S]*?grid-template-columns: 1fr;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.dashboard-service-card-grid,[\s\S]*?grid-template-columns: 1fr;/,
    );
  });

  it("honors reduced-motion accessibility preferences", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: .01ms !important");
  });

  it("uses one consistent icon system instead of text glyphs", () => {
    const source = readFileSync(
      resolve("components/dashboard/Dashboard.tsx"),
      "utf8",
    );
    expect(source).toContain('from "lucide-react"');
    expect(source).toContain("icon={Plus}");
    expect(source).toContain("icon={UsersRound}");
    expect(source).toContain("icon={CalendarDays}");
    expect(source).not.toContain('glyph="P"');
  });
});
