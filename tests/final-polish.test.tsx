import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfirmationProvider,
  useConfirmation,
} from "@/components/feedback/ConfirmationProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import {
  formatDate,
  formatDateTime,
  formatTime,
} from "@/lib/format/date-time";

afterEach(cleanup);

function ConfirmationHarness() {
  const confirm = useConfirmation();
  const [result, setResult] = useState("waiting");

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const accepted = await confirm({
            title: "Remove this record?",
            message: "Its history will remain preserved.",
            confirmLabel: "Remove record",
            tone: "danger",
          });
          setResult(accepted ? "confirmed" : "cancelled");
        }}
      >
        Open confirmation
      </button>
      <output>{result}</output>
    </>
  );
}

describe("final application polish", () => {
  it("renders accessible loading skeletons without exposing decorative rows", () => {
    render(<LoadingSkeleton label="Loading church members" rows={2} />);
    expect(
      screen.getByRole("status", { name: "Loading church members" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading church members")).toHaveClass("sr-only");
  });

  it("renders a consistent empty state with an optional action", () => {
    render(
      <EmptyState
        title="No services yet"
        message="Create the first service when you are ready."
        action={<button type="button">Create service</button>}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No services yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create service" }),
    ).toBeInTheDocument();
  });

  it("uses a consistent accessible confirmation and closes it with Escape", async () => {
    render(
      <ConfirmationProvider>
        <ConfirmationHarness />
      </ConfirmationProvider>,
    );
    const opener = screen.getByRole("button", { name: "Open confirmation" });
    opener.focus();
    fireEvent.click(opener);
    expect(
      screen.getByRole("alertdialog", { name: "Remove this record?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("submits the styled confirmation with its explicit action", async () => {
    render(
      <ConfirmationProvider>
        <ConfirmationHarness />
      </ConfirmationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove record" }));
    await waitFor(() =>
      expect(screen.getByText("confirmed")).toBeInTheDocument(),
    );
  });

  it("formats dates and times consistently and handles invalid values safely", () => {
    expect(formatDate("2026-07-29")).toMatch(/Jul.*29.*2026/);
    expect(formatDateTime("not-a-date", "Unavailable")).toBe("Unavailable");
    expect(formatTime("06:30")).toBe("6:30 AM");
    expect(formatTime("10:30")).toBe("10:30 AM");
    expect(formatTime("18:00")).toBe("6:00 PM");
    expect(formatTime("19:00")).toBe("7:00 PM");
    expect(formatTime("99:00", "No time")).toBe("No time");
  });

  it("uses progressive disclosure for advanced service filters", () => {
    const source = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    expect(source).toContain('aria-controls="service-advanced-filters"');
    expect(source).toContain("More filters");
    expect(source).toContain("advancedFiltersOpen &&");
  });

  it("uses an open structural system instead of nested page cards", () => {
    const styles = readFileSync(resolve("app/globals.css"), "utf8");
    expect(styles).toContain("Open-layout structural system");
    expect(styles).toContain(".dashboard-home-layout {");
    expect(styles).toContain(".settings-section {");
    expect(styles).toContain(".people-directory-workspace,");
    expect(styles).toContain(".users-directory,");
  });
});
