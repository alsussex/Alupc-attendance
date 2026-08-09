import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ServiceModal } from "@/components/services/ServiceManager";
import {
  DEFAULT_APPLICATION_SETTINGS,
  type UserContext,
} from "@/lib/domain";
import { nextServiceDefault } from "@/lib/services/next-service-default";

const timezone = "America/Moncton";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000401",
  organizationId: "20000000-0000-4000-8000-000000000401",
  email: "scheduler@example.test",
  role: "attendance_taker",
};

afterEach(cleanup);

describe("schedule-aware service defaults", () => {
  it.each([
    [
      "Sunday before noon",
      "2026-08-09T14:59:00.000Z",
      "2026-08-09",
      "Sunday Morning",
      "10:30",
    ],
    [
      "Sunday at noon",
      "2026-08-09T15:00:00.000Z",
      "2026-08-09",
      "Sunday Evening",
      "18:30",
    ],
    [
      "Sunday before 9 PM",
      "2026-08-09T23:59:00.000Z",
      "2026-08-09",
      "Sunday Evening",
      "18:30",
    ],
    [
      "Sunday at 9 PM",
      "2026-08-10T00:00:00.000Z",
      "2026-08-12",
      "Wednesday Bible Study",
      "19:00",
    ],
    [
      "Monday",
      "2026-08-10T15:00:00.000Z",
      "2026-08-12",
      "Wednesday Bible Study",
      "19:00",
    ],
    [
      "Wednesday before 9 PM",
      "2026-08-12T23:59:00.000Z",
      "2026-08-12",
      "Wednesday Bible Study",
      "19:00",
    ],
    [
      "Wednesday at 9 PM",
      "2026-08-13T00:00:00.000Z",
      "2026-08-16",
      "Sunday Morning",
      "10:30",
    ],
    [
      "Saturday",
      "2026-08-15T15:00:00.000Z",
      "2026-08-16",
      "Sunday Morning",
      "10:30",
    ],
  ])("selects %s correctly", (_label, instant, date, type, time) => {
    expect(nextServiceDefault(new Date(instant), timezone)).toMatchObject({
      serviceDate: date,
      serviceType: type,
      serviceTime: time,
    });
  });

  it("initializes the shared create dialog with the scheduled service", () => {
    render(
      <ServiceModal
        user={user}
        settings={DEFAULT_APPLICATION_SETTINGS}
        currentDate={new Date("2026-08-09T15:00:00.000Z")}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Service date")).toHaveValue("2026-08-09");
    expect(screen.getByLabelText("Service type")).toHaveValue("Sunday Evening");
    expect(screen.getByLabelText(/Service time/)).toHaveValue("18:30");
  });

  it("respects a renamed system service and its configured default time", () => {
    const settings = {
      ...DEFAULT_APPLICATION_SETTINGS,
      serviceTypes: DEFAULT_APPLICATION_SETTINGS.serviceTypes.map((service) =>
        service.id === "sunday-morning"
          ? { ...service, name: "Sunday Worship", defaultTime: "10:45" }
          : service,
      ),
    };
    render(
      <ServiceModal
        user={user}
        settings={settings}
        currentDate={new Date("2026-08-09T14:00:00.000Z")}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Service type")).toHaveValue("Sunday Worship");
    expect(screen.getByLabelText(/Service time/)).toHaveValue("10:45");
  });
});
