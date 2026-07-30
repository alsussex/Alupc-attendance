import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ServiceModal } from "@/components/services/ServiceManager";
import {
  DEFAULT_APPLICATION_SETTINGS,
  type ApplicationSettings,
  type UserContext,
} from "@/lib/domain";

const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000350",
  organizationId: "20000000-0000-4000-8000-000000000350",
  email: "service-taker@example.test",
  role: "attendance_taker",
};

afterEach(cleanup);

describe("create-service dialog stability", () => {
  it("preserves every entered value and focus during background parent refreshes", () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const settings: ApplicationSettings = {
      ...DEFAULT_APPLICATION_SETTINGS,
      serviceTypes: DEFAULT_APPLICATION_SETTINGS.serviceTypes.map((type) => ({
        ...type,
      })),
    };
    const view = render(
      <ServiceModal
        user={user}
        settings={settings}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Service date"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Service type"), {
      target: { value: "Special Service" },
    });
    fireEvent.change(screen.getByLabelText(/Service time/), {
      target: { value: "17:00" },
    });
    fireEvent.change(screen.getByLabelText(/Custom service name/), {
      target: { value: "Test Build #1" },
    });
    const notes = screen.getByLabelText(/Service notes/);
    fireEvent.change(notes, {
      target: {
        value:
          "This is just a test service with Bro. Kent Calhoun preaching",
      },
    });
    notes.focus();
    const dialogBeforeRefresh = screen.getByRole("dialog");

    // Synchronization and IndexedDB subscriptions update parent state and
    // recreate callback/settings props. The mounted dialog must not reset.
    view.rerender(
      <ServiceModal
        user={{ ...user }}
        settings={{
          ...settings,
          serviceTypes: settings.serviceTypes.map((type) => ({
            ...type,
            enabled: type.name === "Special Service" ? false : type.enabled,
          })),
        }}
        onClose={() => onClose()}
        onSaved={(service) => onSaved(service)}
      />,
    );

    expect(screen.getByRole("dialog")).toBe(dialogBeforeRefresh);
    expect(screen.getByLabelText("Service date")).toHaveValue("2026-08-01");
    expect(screen.getByLabelText("Service type")).toHaveValue(
      "Special Service",
    );
    expect(screen.getByLabelText(/Service time/)).toHaveValue("17:00");
    expect(screen.getByLabelText(/Custom service name/)).toHaveValue(
      "Test Build #1",
    );
    expect(screen.getByLabelText(/Service notes/)).toHaveValue(
      "This is just a test service with Bro. Kent Calhoun preaching",
    );
    expect(document.activeElement).toBe(screen.getByLabelText(/Service notes/));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
