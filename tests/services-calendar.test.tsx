import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesCalendar } from "@/components/services/ServicesCalendar";
import type { ChurchService } from "@/lib/domain";
import {
  buildServiceCalendar,
  shiftMonthKey,
} from "@/lib/services/calendar";
import type { ServiceDirectoryItem } from "@/lib/services/service-directory";
import {
  getPreferredServicesView,
  getServerServicesView,
  setPreferredServicesView,
  subscribeToServicesView,
} from "@/lib/services/view-preference";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function item(
  id: string,
  serviceDate: string,
  customName: string,
  serviceTime: string,
): ServiceDirectoryItem {
  const service: ChurchService = {
    id,
    organizationId: "organization-calendar",
    serviceDate,
    serviceType: "Special Service",
    customName,
    serviceTime,
    status: "draft",
    isArchived: false,
    createdAt: `${serviceDate}T12:00:00.000Z`,
    updatedAt: `${serviceDate}T12:00:00.000Z`,
    createdBy: "admin",
    updatedBy: "admin",
  };
  return {
    service,
    membersPresent: 8,
    visitorsPresent: 2,
    totalPresent: 10,
    pendingSync: false,
    syncState: "synced",
  };
}

const calendarItems = [
  item("service-morning", "2026-07-27", "Morning Prayer", "09:00"),
  item("service-evening", "2026-07-27", "Evening Worship", "18:30"),
  item("service-august", "2026-08-02", "August Service", "10:30"),
];

describe("services calendar model", () => {
  it("builds a complete six-week calendar and highlights service dates", () => {
    const days = buildServiceCalendar(
      calendarItems,
      "2026-07",
      "2026-07-30",
    );
    expect(days).toHaveLength(42);
    expect(days.find((day) => day.dateKey === "2026-07-27")).toMatchObject({
      dayNumber: 27,
      inCurrentMonth: true,
      isToday: false,
    });
    expect(
      days.find((day) => day.dateKey === "2026-07-27")?.services,
    ).toHaveLength(2);
    expect(days.find((day) => day.dateKey === "2026-07-30")).toMatchObject({
      isToday: true,
      services: [],
    });
  });

  it("moves across year boundaries safely", () => {
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
  });

  it("remembers the preferred view on this device", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToServicesView(listener);
    expect(getServerServicesView()).toBe("list");
    expect(getPreferredServicesView()).toBe("list");
    setPreferredServicesView("calendar");
    expect(getPreferredServicesView()).toBe("calendar");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("services calendar interface", () => {
  it("shows all dates but makes only service dates clickable", () => {
    render(
      <ServicesCalendar
        items={calendarItems}
        currentMonthKey="2026-07"
        todayKey="2026-07-30"
        onOpenService={() => undefined}
      />,
    );
    const grid = screen.getByRole("grid", { name: "July 2026" });
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(42);
    expect(
      screen.getByRole("button", {
        name: "Jul 27, 2026, 2 services",
      }),
    ).toBeInTheDocument();
    const emptyDate = screen.getByLabelText("Jul 26, 2026");
    expect(emptyDate.tagName).toBe("DIV");
  });

  it("lists every service on a selected date and opens the chosen service", () => {
    const onOpenService = vi.fn();
    render(
      <ServicesCalendar
        items={calendarItems}
        currentMonthKey="2026-07"
        todayKey="2026-07-30"
        onOpenService={onOpenService}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Jul 27, 2026, 2 services",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Jul 27, 2026" });
    expect(within(dialog).getByText("Morning Prayer")).toBeInTheDocument();
    expect(within(dialog).getByText("Evening Worship")).toBeInTheDocument();
    expect(within(dialog).getByText("6:30 PM")).toBeVisible();
    expect(within(dialog).queryByText("18:30")).not.toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Evening Worship/ }),
    );
    expect(onOpenService).toHaveBeenCalledWith(calendarItems[1].service);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("supports previous, next, today, and month/year picker navigation", () => {
    render(
      <ServicesCalendar
        items={calendarItems}
        currentMonthKey="2026-07"
        todayKey="2026-07-30"
        onOpenService={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(
      screen.getByRole("heading", { name: "August 2026" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(
      screen.getByRole("heading", { name: "July 2026" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choose month and year"), {
      target: { value: "2025-12" },
    });
    expect(
      screen.getByRole("heading", { name: "December 2025" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(
      screen.getByRole("heading", { name: "July 2026" }),
    ).toBeInTheDocument();
  });

  it("keeps the existing list directory and adds accessible view controls", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const styles = readFileSync(resolve("app/globals.css"), "utf8");
    expect(source).toContain("List View");
    expect(source).toContain("Calendar View");
    expect(source).toContain('aria-label="Services view"');
    expect(source).toContain('className="service-year-folder"');
    expect(source).toContain("ServicesCalendar");
    expect(styles).toContain("grid-template-columns: repeat(7");
    expect(styles).toContain("@media (max-width: 680px)");
  });
});
