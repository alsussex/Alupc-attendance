import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/AppShell";
import {
  SIDEBAR_PREFERENCE_KEY,
  getSidebarCollapsedPreference,
  setSidebarCollapsedPreference,
} from "@/lib/navigation/sidebar-preference";

let pathname = "/dashboard";
let role: "admin" | "attendance_taker" = "admin";
const signOut = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: "user-1",
      organizationId: "org-1",
      email: "volunteer@example.test",
      role,
    },
    signOut,
  }),
}));

vi.mock("@/components/shell/SyncIndicator", () => ({
  SyncIndicator: () => <span>Synced</span>,
  SyncBanner: () => null,
}));

vi.mock("@/lib/repositories/settings-repository", () => ({
  getOrganization: async () => ({ name: "Abundant Life UPC" }),
  getOrganizationSettings: async () => ({
    settings: { shortName: "ALUPC" },
  }),
}));

vi.mock("@/lib/storage/data-events", () => ({
  subscribeToDataChanges: () => () => undefined,
}));

describe("application navigation", () => {
  beforeEach(() => {
    pathname = "/dashboard";
    role = "admin";
    signOut.mockReset();
    window.localStorage.clear();
    document.body.style.overflow = "";
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
  });

  it("expands and collapses the desktop sidebar and saves the preference", () => {
    const { container } = render(<AppShell><p>Page</p></AppShell>);

    expect(container.querySelector(".app-layout")).not.toHaveClass(
      "sidebar-collapsed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(container.querySelector(".app-layout")).toHaveClass(
      "sidebar-collapsed",
    );
    expect(getSidebarCollapsedPreference()).toBe(true);
    expect(screen.getByRole("link", { name: "People" })).toHaveAttribute(
      "title",
      "People",
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(container.querySelector(".app-layout")).not.toHaveClass(
      "sidebar-collapsed",
    );
    expect(getSidebarCollapsedPreference()).toBe(false);
  });

  it("restores a saved collapsed preference with labels and tooltips intact", async () => {
    setSidebarCollapsedPreference(true);
    const { container } = render(<AppShell><p>Page</p></AppShell>);

    await waitFor(() =>
      expect(container.querySelector(".app-layout")).toHaveClass(
        "sidebar-collapsed",
      ),
    );
    expect(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY)).toBe("true");
    const services = within(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).getByRole("link", { name: "Services" });
    expect(services).toHaveAttribute("title", "Services");
    expect(services.querySelector(".sidebar-label")).toHaveTextContent(
      "Services",
    );
  });

  it("uses recognizable Lucide icons and preserves active accessible labels", () => {
    const { container } = render(<AppShell><p>Page</p></AppShell>);

    expect(
      within(screen.getByRole("navigation", { name: "Main navigation" }))
        .getByRole("link", { name: "Dashboard" }),
    ).toHaveAttribute("aria-current", "page");
    expect(container.querySelector(".lucide-layout-dashboard")).toBeTruthy();
    expect(container.querySelector(".lucide-users-round")).toBeTruthy();
    expect(container.querySelector(".lucide-calendar-days")).toBeTruthy();
    expect(container.querySelector(".lucide-settings")).toBeTruthy();
  });

  it("opens and closes the mobile menu using its controls and backdrop", () => {
    const { container } = render(<AppShell><p>Page</p></AppShell>);
    const open = screen.getByRole("button", { name: "Open navigation menu" });

    fireEvent.click(open);
    expect(screen.getByRole("dialog", { name: "Navigation menu" })).toBeVisible();
    expect(document.body.style.overflow).toBe("hidden");
    expect(
      screen.getAllByRole("button", { name: "Close navigation menu" })[1],
    ).toHaveFocus();

    fireEvent.click(container.querySelector(".mobile-nav-backdrop")!);
    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the mobile menu with Escape and restores focus", async () => {
    render(<AppShell><p>Page</p></AppShell>);
    const open = screen.getByRole("button", { name: "Open navigation menu" });
    fireEvent.click(open);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Navigation menu" }), {
      key: "Escape",
    });

    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
  });

  it("closes the mobile menu after route selection", () => {
    render(<AppShell><p>Page</p></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const mobileNavigation = screen.getByRole("navigation", {
      name: "Mobile navigation",
    });
    fireEvent.click(
      mobileNavigation.querySelector('a[href="/people"]') as HTMLElement,
    );

    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).toBeNull();
  });

  it("keeps Admin navigation permission filtering unchanged", () => {
    const { rerender } = render(<AppShell><p>Page</p></AppShell>);
    const mainNavigation = () =>
      within(screen.getByRole("navigation", { name: "Main navigation" }));
    expect(mainNavigation().getByRole("link", { name: "Settings" })).toBeInTheDocument();

    role = "attendance_taker";
    rerender(<AppShell><p>Page</p></AppShell>);
    expect(mainNavigation().queryByRole("link", { name: "Settings" })).toBeNull();
    expect(mainNavigation().getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(mainNavigation().getByRole("link", { name: "People" })).toBeInTheDocument();
    expect(mainNavigation().getByRole("link", { name: "Services" })).toBeInTheDocument();
  });
});
