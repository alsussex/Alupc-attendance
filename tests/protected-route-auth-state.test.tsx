import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserContext } from "@/lib/domain";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refreshAccess: vi.fn(),
  state: {} as {
    loading: boolean;
    session: Session | null;
    user: UserContext | null;
    error: string | null;
    sessionNeedsAttention: boolean;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({
    ...mocks.state,
    refreshAccess: mocks.refreshAccess,
  }),
}));

const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000180",
  organizationId: "20000000-0000-4000-8000-000000000180",
  email: "admin@example.test",
  role: "admin",
};

const session = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: "bearer",
  user: {
    id: user.userId,
    email: user.email,
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-07-01T00:00:00.000Z",
  },
} as Session;

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.refreshAccess.mockReset();
  mocks.state = {
    loading: false,
    session,
    user,
    error: null,
    sessionNeedsAttention: false,
  };
});

afterEach(cleanup);

describe("protected route authentication states", () => {
  it("opens the app whenever the restored authorized user is valid", () => {
    render(
      <ProtectedRoute>
        <p>Attendance workspace</p>
      </ProtectedRoute>,
    );

    expect(screen.getByText("Attendance workspace")).toBeInTheDocument();
    expect(screen.queryByText(/repair sign-in/i)).not.toBeInTheDocument();
  });

  it("separates temporary church-data loading from sign-in repair", () => {
    mocks.state = {
      ...mocks.state,
      user: null,
      error:
        "Your sign-in is valid, but church access could not be loaded. We will retry automatically.",
    };

    render(
      <ProtectedRoute>
        <p>Attendance workspace</p>
      </ProtectedRoute>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Church data is temporarily unavailable",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry church access" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/repair sign-in/i)).not.toBeInTheDocument();
  });

  it("requests a new sign-in only after a confirmed invalid session", () => {
    mocks.state = {
      ...mocks.state,
      user: null,
      error: "Your saved sign-in has expired. Please sign in again.",
      sessionNeedsAttention: true,
    };

    render(
      <ProtectedRoute>
        <p>Attendance workspace</p>
      </ProtectedRoute>,
    );

    expect(
      screen.getByRole("heading", { name: "Sign-in needs attention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Sign in again" }),
    ).toHaveAttribute("href", "/login");
    expect(
      screen.queryByRole("button", { name: "Retry church access" }),
    ).not.toBeInTheDocument();
  });

  it("redirects a genuinely signed-out user to login", async () => {
    mocks.state = {
      loading: false,
      session: null,
      user: null,
      error: null,
      sessionNeedsAttention: false,
    };

    render(
      <ProtectedRoute>
        <p>Attendance workspace</p>
      </ProtectedRoute>,
    );

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
  });
});
