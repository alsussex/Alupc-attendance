import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS, type ChurchService } from "@/lib/domain";
import { ServiceManager } from "@/components/services/ServiceManager";

let searchParameters = new URLSearchParams();
const push = vi.fn();
const back = vi.fn();
const replace = vi.fn();

const service: ChurchService = {
  id: "30000000-0000-4000-8000-000000000981",
  organizationId: "20000000-0000-4000-8000-000000000981",
  serviceDate: "2026-08-02",
  serviceType: "Sunday Morning",
  serviceTime: "10:30",
  status: "draft",
  isArchived: false,
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
  createdBy: "10000000-0000-4000-8000-000000000981",
  updatedBy: "10000000-0000-4000-8000-000000000981",
};

function setSearch(value: string) {
  searchParameters = new URLSearchParams(value);
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back, replace }),
  useSearchParams: () => searchParameters,
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      userId: "10000000-0000-4000-8000-000000000981",
      organizationId: "20000000-0000-4000-8000-000000000981",
      email: "volunteer@example.test",
      role: "attendance_taker",
    },
  }),
}));

vi.mock("@/components/sync/SyncProvider", () => ({
  useSynchronization: () => ({ syncNow: vi.fn() }),
}));

vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/components/feedback/ConfirmationProvider", () => ({
  useConfirmation: () => async () => true,
}));

vi.mock("@/lib/storage/data-events", () => ({
  subscribeToDataChanges: () => () => undefined,
}));

vi.mock("@/lib/services/view-preference", () => ({
  getPreferredServicesView: () => "list",
  getServerServicesView: () => "list",
  setPreferredServicesView: vi.fn(),
  subscribeToServicesView: () => () => undefined,
}));

vi.mock("@/lib/repositories/settings-repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repositories/settings-repository")>()),
  getOrganizationSettings: async () => ({
    id: service.organizationId,
    organizationId: service.organizationId,
    settings: DEFAULT_APPLICATION_SETTINGS,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  }),
}));

vi.mock("@/lib/services/service-directory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/services/service-directory")>()),
  loadOrganizationServiceDirectory: async () => [
    {
      service,
      membersPresent: 0,
      visitorsPresent: 0,
      totalPresent: 0,
      pendingSync: false,
      syncState: "synced",
    },
  ],
}));

vi.mock("@/lib/repositories/attendance-repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repositories/attendance-repository")>()),
  getOrganizationService: async (_organizationId: string, id: string) =>
    id === service.id ? service : undefined,
  getServiceAttendance: async () => [],
  listActiveMembers: async () => [],
  listMembers: async () => [],
  listServiceVisitors: async () => [],
}));

vi.mock("@/lib/sync/visitor-conflicts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/visitor-conflicts")>()),
  listVisitorConflicts: async () => [],
}));

vi.mock("@/lib/sync/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sync/queue")>()),
  getPendingChanges: async () => [],
}));

describe("service browser navigation", () => {
  beforeEach(() => {
    setSearch("");
    push.mockReset();
    back.mockReset();
    replace.mockReset();
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window.history, "length", {
      configurable: true,
      value: 1,
    });
  });

  it("pushes a service URL so browser Back returns to the Services list entry", async () => {
    Object.defineProperty(window.history, "length", {
      configurable: true,
      value: 2,
    });
    const view = render(<ServiceManager />);
    const row = await waitFor(() =>
      expect(document.querySelector(".service-directory-row")).toBeTruthy(),
    ).then(() => document.querySelector(".service-directory-row")!);
    fireEvent.click(row);

    expect(push).toHaveBeenCalledWith(
      `/services?service=${encodeURIComponent(service.id)}`,
      { scroll: false },
    );
    expect(await screen.findByRole("button", { name: /Back/ })).toBeVisible();
    setSearch(`service=${service.id}`);
    view.rerender(<ServiceManager />);
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(back).toHaveBeenCalledTimes(1);

    setSearch("");
    view.rerender(<ServiceManager />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Services" })).toBeVisible(),
    );
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("opens a direct service URL and preserves it across the initial render", async () => {
    setSearch(`service=${service.id}`);
    render(<ServiceManager />);
    expect(await screen.findByRole("button", { name: /Back/ })).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });

  it("falls back to the Services list when a direct URL has no prior history", async () => {
    setSearch(`service=${service.id}`);
    render(<ServiceManager />);
    fireEvent.click(await screen.findByRole("button", { name: /Back/ }));
    expect(replace).toHaveBeenCalledWith("/services", { scroll: false });
    expect(back).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Services" }),
    ).toBeVisible();
  });

  it("returns to all services when the sidebar removes the service query", async () => {
    setSearch(`service=${service.id}`);
    const view = render(<ServiceManager />);
    expect(await screen.findByRole("button", { name: /Back/ })).toBeVisible();

    // The sidebar Services link navigates to /services, which removes the
    // service query while keeping this route component mounted.
    setSearch("");
    view.rerender(<ServiceManager />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Services" })).toBeVisible(),
    );
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });
});
