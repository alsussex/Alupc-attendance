import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthProvider,
  accessRetryDelay,
  isInvalidRefreshFailure,
  isTemporaryAuthFailure,
  sessionNeedsRefresh,
  useAuth,
} from "@/components/auth/AuthProvider";
import { clearLocalDatabase } from "@/lib/storage/database";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  from: vi.fn(),
  authCallback: null as
    | ((event: AuthChangeEvent, session: Session | null) => void)
    | null,
  profileResponse: {
    data: null as Record<string, unknown> | null,
    error: null as Record<string, unknown> | null,
  },
  organizationResponse: {
    data: null as Record<string, unknown> | null,
    error: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  hasSupabaseConfig: () => true,
  getSupabaseClient: () => ({
    auth: {
      getSession: mocks.getSession,
      refreshSession: mocks.refreshSession,
      signInWithPassword: mocks.signInWithPassword,
      signOut: mocks.signOut,
      onAuthStateChange: mocks.onAuthStateChange,
    },
    from: mocks.from,
  }),
}));

const userId = "10000000-0000-4000-8000-000000000170";
const organizationId = "20000000-0000-4000-8000-000000000170";

function makeSession(
  suffix: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): Session {
  return {
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: "bearer",
    user: {
      id: userId,
      email: "admin@example.test",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-07-01T00:00:00.000Z",
    },
  };
}

function setSuccessfulAccess(role: "admin" | "attendance_taker" = "admin") {
  mocks.profileResponse = {
    data: {
      organization_id: organizationId,
      display_name: "Fictional Admin",
      role,
      is_active: true,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    },
    error: null,
  };
  mocks.organizationResponse = {
    data: {
      id: organizationId,
      name: "Fictional Community Church",
      slug: "fictional-community",
      version: 2,
      created_by: userId,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:00.000Z",
    },
    error: null,
  };
}

function cacheAuthorizedUser(role: "admin" | "attendance_taker" = "admin") {
  localStorage.setItem(
    `church-attendance-profile:${userId}`,
    JSON.stringify({
      userId,
      organizationId,
      email: "admin@example.test",
      role,
    }),
  );
}

function AuthProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="user">
        {auth.user ? `${auth.user.userId}:${auth.user.role}` : "none"}
      </span>
      <span data-testid="session">
        {auth.session ? auth.session.access_token : "none"}
      </span>
      <span data-testid="attention">
        {String(auth.sessionNeedsAttention)}
      </span>
      <span data-testid="error">{auth.error ?? ""}</span>
      <button type="button" onClick={() => void auth.refreshAccess()}>
        Refresh access
      </button>
      <button type="button" onClick={() => void auth.recoverSession()}>
        Recover session
      </button>
      <button
        type="button"
        onClick={() =>
          void auth.signIn("admin@example.test", "fictional-password")
        }
      >
        Sign in
      </button>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
    </div>
  );
}

async function expectAuthorized(role = "admin") {
  await waitFor(() =>
    expect(screen.getByTestId("user")).toHaveTextContent(`${userId}:${role}`),
  );
  expect(screen.getByTestId("attention")).toHaveTextContent("false");
}

beforeEach(async () => {
  await clearLocalDatabase();
  localStorage.clear();
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.getSession.mockReset();
  mocks.refreshSession.mockReset();
  mocks.signInWithPassword.mockReset();
  mocks.signOut.mockReset();
  mocks.onAuthStateChange.mockReset();
  mocks.unsubscribe.mockReset();
  mocks.from.mockReset();
  mocks.authCallback = null;
  setSuccessfulAccess();

  mocks.from.mockImplementation((table: string) => {
    const response =
      table === "profiles"
        ? () => mocks.profileResponse
        : () => mocks.organizationResponse;
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => response(),
    };
    return query;
  });
  mocks.onAuthStateChange.mockImplementation(
    (
      callback: (event: AuthChangeEvent, session: Session | null) => void,
    ) => {
      mocks.authCallback = callback;
      return {
        data: {
          subscription: {
            unsubscribe: mocks.unsubscribe,
          },
        },
      };
    },
  );
  mocks.signOut.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
});

describe("authentication startup and refresh recovery", () => {
  it("restores a valid session on app reload without forcing a refresh", async () => {
    const session = makeSession("reload");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired access token once and opens with the new session", async () => {
    const expired = makeSession(
      "expired",
      Math.floor(Date.now() / 1000) - 30,
    );
    const refreshed = makeSession("refreshed");
    mocks.getSession.mockResolvedValue({
      data: { session: expired },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: refreshed },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("session")).toHaveTextContent("access-refreshed");
  });

  it("reloads profile and organization after TOKEN_REFRESHED", async () => {
    const initial = makeSession("initial");
    const refreshed = makeSession(
      "token-event",
      Math.floor(Date.now() / 1000) + 7200,
    );
    mocks.getSession.mockResolvedValue({
      data: { session: initial },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await expectAuthorized();
    setSuccessfulAccess("attendance_taker");

    await act(async () => {
      mocks.authCallback?.("TOKEN_REFRESHED", refreshed);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await expectAuthorized("attendance_taker");
    expect(screen.getByTestId("session")).toHaveTextContent(
      "access-token-event",
    );
  });

  it("keeps a valid cached account open when profile loading fails", async () => {
    cacheAuthorizedUser();
    const session = makeSession("profile-failure");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    mocks.profileResponse = {
      data: null,
      error: { code: "PGRST301", message: "Row policy rejected the query" },
    };

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(console.error).toHaveBeenCalledWith(
      "[Church Attendance auth]",
      expect.objectContaining({
        phase: "profile-load",
        code: "PGRST301",
      }),
    );
  });

  it("keeps a valid cached account open when organization loading fails", async () => {
    cacheAuthorizedUser();
    const session = makeSession("organization-failure");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    mocks.organizationResponse = {
      data: null,
      error: { code: "PGRST116", message: "Organization temporarily unavailable" },
    };

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("opens from cached authorization during a network interruption", async () => {
    cacheAuthorizedUser("attendance_taker");
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const session = makeSession("offline");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized("attendance_taker");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("recovers church context from IndexedDB when localStorage cache is missing", async () => {
    const session = makeSession("indexeddb-fallback");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    mocks.profileResponse = {
      data: null,
      error: { code: "PGRST116", message: "Profile temporarily unavailable" },
    };
    const database = await import("@/lib/storage/database").then((module) =>
      module.getDatabase(),
    );
    await database.put("profiles", {
      id: userId,
      organizationId,
      displayName: "Fictional Admin",
      role: "admin",
      isActive: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    await database.put("organizations", {
      id: organizationId,
      name: "Fictional Community Church",
      slug: "fictional-community",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(localStorage.getItem(`church-attendance-profile:${userId}`)).toContain(
      organizationId,
    );
  });

  it("adopts a session refreshed by another tab after refresh-token rotation", async () => {
    const expired = makeSession(
      "rotated-old",
      Math.floor(Date.now() / 1000) - 30,
    );
    const concurrent = makeSession("rotated-new");
    mocks.getSession
      .mockResolvedValueOnce({ data: { session: expired }, error: null })
      .mockResolvedValueOnce({ data: { session: concurrent }, error: null });
    mocks.refreshSession.mockResolvedValue({
      data: { session: null },
      error: {
        status: 400,
        code: "refresh_token_already_used",
        message: "Refresh token already used",
      },
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await expectAuthorized();
    expect(screen.getByTestId("session")).toHaveTextContent(
      "access-rotated-new",
    );
    expect(screen.getByTestId("attention")).toHaveTextContent("false");
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("validates healthy access without rotating a refresh token", async () => {
    const session = makeSession("healthy-access");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await expectAuthorized();

    await act(async () => {
      screen.getByRole("button", { name: "Refresh access" }).click();
    });

    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
});

describe("authentication events and loop prevention", () => {
  it("keeps one listener active across rerenders and accepts multi-tab events", async () => {
    const session = makeSession("multi-tab");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    const view = render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await expectAuthorized();

    view.rerender(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await act(async () => {
      mocks.authCallback?.("SIGNED_IN", session);
      mocks.authCallback?.("SIGNED_IN", session);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("clears state on sign out and restores it on the next sign in", async () => {
    const initial = makeSession("before-signout");
    const signedInAgain = makeSession(
      "signed-in-again",
      Math.floor(Date.now() / 1000) + 7200,
    );
    mocks.getSession.mockResolvedValue({
      data: { session: initial },
      error: null,
    });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    await expectAuthorized();

    await act(async () => {
      mocks.authCallback?.("SIGNED_OUT", null);
    });
    await waitFor(() =>
      expect(screen.getByTestId("user")).toHaveTextContent("none"),
    );

    await act(async () => {
      mocks.authCallback?.("SIGNED_IN", signedInAgain);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await expectAuthorized();
  });

  it("does not turn profile access failures into repair-sign-in loops", async () => {
    const session = makeSession("no-cache-profile-failure");
    mocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    mocks.profileResponse = {
      data: null,
      error: { code: "42501", message: "RLS denied this profile read" },
    };

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("session")).toHaveTextContent(
      "access-no-cache-profile-failure",
    );
    expect(screen.getByTestId("attention")).toHaveTextContent("false");
    expect(screen.getByTestId("error")).toHaveTextContent(
      "sign-in is valid",
    );
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
});

describe("auth failure classification", () => {
  it("distinguishes temporary failures, invalid refresh tokens, and expiry", () => {
    expect(isTemporaryAuthFailure(new Error("Network request timed out"))).toBe(
      true,
    );
    expect(
      isInvalidRefreshFailure({
        status: 400,
        code: "refresh_token_not_found",
        message: "Invalid refresh token",
      }),
    ).toBe(true);
    expect(
      sessionNeedsRefresh(
        makeSession("near-expiry", Math.floor(Date.now() / 1000) + 20),
      ),
    ).toBe(true);
    expect(sessionNeedsRefresh(makeSession("healthy"))).toBe(false);
    expect([1, 2, 3, 4].map(accessRetryDelay)).toEqual([
      1_000,
      3_000,
      10_000,
      undefined,
    ]);
  });
});
