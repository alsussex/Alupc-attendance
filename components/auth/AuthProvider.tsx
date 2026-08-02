"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import type { UserContext } from "@/lib/domain";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { getDatabase } from "@/lib/storage/database";
import { getSupabaseClient, hasSupabaseConfig } from "@/lib/supabase/client";

interface AuthState {
  loading: boolean;
  session: Session | null;
  user: UserContext | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshAccess: () => Promise<UserContext | null>;
  recoverSession: () => Promise<UserContext | null>;
  sessionNeedsAttention: boolean;
  authRevision: number;
}

const AuthContext = createContext<AuthState | null>(null);

function profileCacheKey(userId: string) {
  return `church-attendance-profile:${userId}`;
}

function authErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: String(error ?? "Unknown authentication error") };
  }
  const value = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    name?: unknown;
  };
  return {
    message:
      typeof value.message === "string"
        ? value.message
        : "Unknown authentication error",
    code: typeof value.code === "string" ? value.code : undefined,
    status: typeof value.status === "number" ? value.status : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}

export function logAuthDiagnostic(
  phase: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  console.error("[Church Attendance auth]", {
    phase,
    ...authErrorDetails(error),
    ...context,
  });
}

export function isTemporaryAuthFailure(error: unknown) {
  const { message, status } = authErrorDetails(error);
  return (
    status === 0 ||
    (typeof status === "number" && status >= 500) ||
    /fetch|network|connection|timeout|offline|temporar|gateway/i.test(message)
  );
}

export function isInvalidRefreshFailure(error: unknown) {
  const { message, code, status } = authErrorDetails(error);
  return (
    code === "refresh_token_not_found" ||
    code === "refresh_token_already_used" ||
    (status === 400 &&
      /refresh token|invalid token|session.*missing|session.*expired/i.test(
        message,
      ))
  );
}

export function sessionNeedsRefresh(
  session: Session,
  nowMilliseconds = Date.now(),
) {
  if (!session.expires_at) return false;
  return session.expires_at * 1000 <= nowMilliseconds + 60_000;
}

export function accessRetryDelay(attempt: number) {
  return [1_000, 3_000, 10_000][attempt - 1];
}

export function shouldRevalidateAccess(
  lastCheckAt: number,
  force = false,
  now = Date.now(),
) {
  return force || now - lastCheckAt >= 5 * 60_000;
}

function sessionIsUsable(session: Session, nowMilliseconds = Date.now()) {
  return !session.expires_at || session.expires_at * 1000 > nowMilliseconds;
}

function removeCachedProfile(userId: string) {
  try {
    localStorage.removeItem(profileCacheKey(userId));
  } catch (caught) {
    logAuthDiagnostic("profile-cache-remove", caught, { userId });
  }
}

function readLocalStorageProfile(userId: string) {
  let value: string | null = null;
  try {
    value = localStorage.getItem(profileCacheKey(userId));
  } catch (caught) {
    logAuthDiagnostic("profile-cache-read", caught, { userId });
  }
  if (!value) return null;
  try {
    const cached = JSON.parse(value) as UserContext;
    if (!cached.organizationId || cached.userId !== userId) return null;
    return {
      ...cached,
      role: cached.role === "admin" ? "admin" : "attendance_taker",
    } satisfies UserContext;
  } catch {
    removeCachedProfile(userId);
    return null;
  }
}

async function readCachedProfile(userId: string, email: string) {
  const localProfile = readLocalStorageProfile(userId);
  if (localProfile) return localProfile;

  try {
    const database = await getDatabase();
    const profile = await database.get("profiles", userId);
    if (!profile?.isActive || !profile.organizationId) return null;
    const organization = await database.get(
      "organizations",
      profile.organizationId,
    );
    if (!organization) return null;
    const cached: UserContext = {
      userId,
      organizationId: profile.organizationId,
      email,
      role: profile.role === "admin" ? "admin" : "attendance_taker",
    };
    writeCachedProfile(cached);
    return cached;
  } catch (caught) {
    logAuthDiagnostic("indexeddb-profile-cache-read", caught, { userId });
    return null;
  }
}

function writeCachedProfile(user: UserContext) {
  try {
    localStorage.setItem(profileCacheKey(user.userId), JSON.stringify(user));
  } catch (caught) {
    logAuthDiagnostic("profile-cache-write", caught, {
      userId: user.userId,
      organizationId: user.organizationId,
    });
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = hasSupabaseConfig();
  const [loading, setLoading] = useState(configured);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<UserContext | null>(null);
  const [error, setError] = useState<string | null>(
    configured
      ? null
      : "Supabase is not configured. Copy .env.example to .env.local and add your project values.",
  );
  const [sessionNeedsAttention, setSessionNeedsAttention] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const [accessFailureSequence, setAccessFailureSequence] = useState(0);
  const refreshPromises = useRef<{
    regular?: Promise<UserContext | null>;
    forced?: Promise<UserContext | null>;
  }>({});
  const profilePromise = useRef<{
    key: string;
    promise: Promise<UserContext | null>;
  } | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const profileRequest = useRef(0);
  const sessionUserId = useRef<string | null>(null);
  const authSubscription = useRef<{ unsubscribe: () => void } | null>(null);
  const lastAuthEvent = useRef<{ key: string; at: number } | null>(null);
  const lastLoadedAccessToken = useRef<string | null>(null);
  const lastFocusAccessCheck = useRef(0);

  const loadProfile = useCallback(async (
    nextSession: Session | null,
  ): Promise<UserContext | null> => {
    sessionRef.current = nextSession;
    setSession(nextSession);
    if (!nextSession) {
      sessionUserId.current = null;
      profileRequest.current += 1;
      profilePromise.current = null;
      lastLoadedAccessToken.current = null;
      setUser(null);
      setError(null);
      setSessionNeedsAttention(false);
      setAccessFailureSequence(0);
      setLoading(false);
      return null;
    }

    const authUser = nextSession.user;
    if (sessionUserId.current !== authUser.id) {
      sessionUserId.current = authUser.id;
      setAccessFailureSequence(0);
    }
    const profileKey = `${authUser.id}:${nextSession.access_token}`;
    if (profilePromise.current?.key === profileKey) {
      return profilePromise.current.promise;
    }
    const requestId = ++profileRequest.current;
    const cached = await readCachedProfile(
      authUser.id,
      authUser.email ?? "",
    );
    if (profileRequest.current !== requestId) return null;
    if (cached) {
      setUser(cached);
      setError(null);
      setSessionNeedsAttention(false);
      setLoading(false);
    }
    if (!navigator.onLine && cached) {
      return cached;
    }

    const promise = (async () => {
      const supabase = getSupabaseClient();
      const { data, error: profileError } = await supabase
        .from("profiles")
        .select("organization_id, display_name, role, is_active, theme_preference, version, created_at, updated_at")
        .eq("id", authUser.id)
        .single();

      const { data: organization, error: organizationError } = data?.organization_id
        ? await supabase
            .from("organizations")
            .select("id, name, slug, created_by, created_at, updated_at, version")
            .eq("id", data.organization_id)
            .single()
        : { data: null, error: null };

      if (profileRequest.current !== requestId) return null;

      if (data && data.is_active === false) {
        removeCachedProfile(authUser.id);
        setUser(null);
        setSessionNeedsAttention(false);
        setError("Your church access has been disabled.");
        setAccessFailureSequence(0);
        setLoading(false);
        return null;
      }

      if (
        profileError ||
        organizationError ||
        !data?.organization_id ||
        !organization
      ) {
        const failure = profileError ?? organizationError ?? new Error(
          !data?.organization_id
            ? "Profile organization is unavailable."
            : "Organization record is unavailable.",
        );
        logAuthDiagnostic(
          profileError ? "profile-load" : "organization-load",
          failure,
          {
            userId: authUser.id,
            hasCachedProfile: Boolean(cached),
          },
        );
        if (cached) {
          setUser(cached);
          setError(null);
          setSessionNeedsAttention(false);
          setLoading(false);
          return cached;
        }
        setUser(null);
        setSessionNeedsAttention(false);
        setError(
          "Your sign-in is valid, but church access could not be loaded. We will retry automatically.",
        );
        setAccessFailureSequence((current) => current + 1);
        setLoading(false);
        return null;
      }

      const nextUser: UserContext = {
        userId: authUser.id,
        organizationId: data.organization_id,
        email: authUser.email ?? "",
        role: data.role === "admin" ? "admin" : "attendance_taker",
      };
      writeCachedProfile(nextUser);
      setUser((current) =>
        current &&
        current.userId === nextUser.userId &&
        current.organizationId === nextUser.organizationId &&
        current.email === nextUser.email &&
        current.role === nextUser.role
          ? current
          : nextUser,
      );
      setError(null);
      setSessionNeedsAttention(false);
      setAccessFailureSequence(0);
      setLoading(false);

      try {
        const database = await getDatabase();
        await Promise.all([
          database.put("profiles", {
            id: authUser.id,
            organizationId: data.organization_id,
            displayName: data.display_name ?? undefined,
            role: nextUser.role,
            isActive: data.is_active,
            themePreference:
              data.theme_preference === "light" ||
              data.theme_preference === "dark"
                ? data.theme_preference
                : "system",
            version:
              typeof data.version === "number" ? data.version : undefined,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
          }),
          database.put("organizations", {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            version:
              typeof organization.version === "number"
                ? organization.version
                : undefined,
            createdBy: organization.created_by ?? undefined,
            createdAt: organization.created_at,
            updatedAt: organization.updated_at,
          }),
        ]);
      } catch (caught) {
        logAuthDiagnostic("offline-cache-write", caught, {
          userId: authUser.id,
          organizationId: nextUser.organizationId,
        });
      }
      lastLoadedAccessToken.current = nextSession.access_token;
      return nextUser;
    })()
      .catch((caught) => {
        if (profileRequest.current !== requestId) return null;
        logAuthDiagnostic("access-load-unexpected", caught, {
          userId: authUser.id,
          hasCachedProfile: Boolean(cached),
        });
        if (cached) {
          setUser(cached);
          setError(null);
          setSessionNeedsAttention(false);
          setLoading(false);
          return cached;
        }
        setUser(null);
        setSessionNeedsAttention(false);
        setError(
          "Your sign-in is valid, but church access could not be loaded. We will retry automatically.",
        );
        setAccessFailureSequence((current) => current + 1);
        setLoading(false);
        return null;
      })
      .finally(() => {
        if (profilePromise.current?.key === profileKey) {
          profilePromise.current = null;
        }
      });
    profilePromise.current = { key: profileKey, promise };
    return promise;
  }, []);

  const restoreSession = useCallback(
    (forceRefresh = false): Promise<UserContext | null> => {
      if (forceRefresh && refreshPromises.current.forced) {
        return refreshPromises.current.forced;
      }
      if (!forceRefresh) {
        const existing =
          refreshPromises.current.forced ?? refreshPromises.current.regular;
        if (existing) return existing;
      }
      const promiseKey = forceRefresh ? "forced" : "regular";
      const refresh = (async () => {
        const supabase = getSupabaseClient();
        let storedSession = sessionRef.current;
        try {
          const { data, error: sessionError } =
            await supabase.auth.getSession();
          if (sessionError) throw sessionError;
          storedSession = data.session;
        } catch (caught) {
          logAuthDiagnostic("session-restore", caught, {
            hasInMemorySession: Boolean(storedSession),
          });
          if (storedSession) return loadProfile(storedSession);
          setLoading(false);
          setSessionNeedsAttention(false);
          setError(
            "Your saved sign-in could not be checked. We will retry automatically.",
          );
          return null;
        }

        if (!storedSession) return loadProfile(null);
        if (!navigator.onLine) return loadProfile(storedSession);

        if (forceRefresh || sessionNeedsRefresh(storedSession)) {
          const { data, error: refreshError } =
            await supabase.auth.refreshSession();
          if (refreshError || !data.session) {
            const failure =
              refreshError ??
              new Error("Supabase did not return a refreshed session.");
            logAuthDiagnostic("session-refresh", failure, {
              userId: storedSession.user.id,
              accessTokenUsable: sessionIsUsable(storedSession),
              forced: forceRefresh,
            });
            if (
              isTemporaryAuthFailure(failure) ||
              sessionIsUsable(storedSession)
            ) {
              return loadProfile(storedSession);
            }
            if (isInvalidRefreshFailure(failure)) {
              try {
                const { data: latest, error: latestError } =
                  await supabase.auth.getSession();
                if (
                  !latestError &&
                  latest.session &&
                  latest.session.access_token !== storedSession.access_token &&
                  sessionIsUsable(latest.session)
                ) {
                  logAuthDiagnostic("session-refresh-adopted", failure, {
                    userId: storedSession.user.id,
                    recoveredFromAnotherTab: true,
                  });
                  return loadProfile(latest.session);
                }
              } catch (caught) {
                logAuthDiagnostic("session-refresh-recheck", caught, {
                  userId: storedSession.user.id,
                });
              }
              setSession(storedSession);
              setUser(null);
              setSessionNeedsAttention(true);
              setError(
                "Your saved sign-in has expired. Please sign in again.",
              );
              setLoading(false);
              return null;
            }
            setSessionNeedsAttention(false);
            setError(
              "Your sign-in could not be refreshed yet. We will retry automatically.",
            );
            setLoading(false);
            return null;
          }
          storedSession = data.session;
        }

        return loadProfile(storedSession);
      })().finally(() => {
        if (refreshPromises.current[promiseKey] === refresh) {
          delete refreshPromises.current[promiseKey];
        }
      });
      refreshPromises.current[promiseKey] = refresh;
      return refresh;
    },
    [loadProfile],
  );

  const refreshAccess = useCallback(
    () => restoreSession(false),
    [restoreSession],
  );

  const recoverSession = useCallback(
    () => restoreSession(true),
    [restoreSession],
  );

  useEffect(() => {
    if (!configured) return;
    if (authSubscription.current) return;
    const supabase = getSupabaseClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "SIGNED_OUT") {
        void loadProfile(null);
        return;
      }
      if (
        event === "INITIAL_SESSION" ||
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED" ||
        event === "PASSWORD_RECOVERY"
      ) {
        if (
          (event === "INITIAL_SESSION" || event === "SIGNED_IN") &&
          nextSession?.access_token === lastLoadedAccessToken.current
        ) {
          return;
        }
        const eventKey = `${event}:${nextSession?.user.id ?? "none"}:${nextSession?.access_token ?? "none"}`;
        const now = Date.now();
        if (
          lastAuthEvent.current?.key === eventKey &&
          now - lastAuthEvent.current.at < 1_000
        ) {
          return;
        }
        lastAuthEvent.current = { key: eventKey, at: now };
        window.setTimeout(
          () =>
            void loadProfile(nextSession).then((nextUser) => {
              if (nextUser) {
                setAuthRevision((current) => current + 1);
              }
            }),
          0,
        );
      }
    });
    authSubscription.current = subscription;
    void restoreSession(false);
    return () => {
      if (authSubscription.current === subscription) {
        authSubscription.current = null;
      }
      subscription.unsubscribe();
    };
  }, [configured, loadProfile, restoreSession]);

  useEffect(() => {
    if (
      !session ||
      user ||
      !error ||
      sessionNeedsAttention ||
      !navigator.onLine ||
      accessFailureSequence < 1 ||
      accessFailureSequence > 3
    ) {
      return;
    }
    const retryNumber = accessFailureSequence;
    const delay = accessRetryDelay(retryNumber);
    if (delay === undefined) return;
    const timer = window.setTimeout(() => {
      logAuthDiagnostic("access-load-retry", new Error(error), {
        userId: session.user.id,
        attempt: retryNumber,
      });
      void restoreSession(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    accessFailureSequence,
    error,
    restoreSession,
    session,
    sessionNeedsAttention,
    user,
  ]);

  useEffect(() => {
    if (!user) return;

    const refreshCachedRole = async () => {
      const profile = await (await getDatabase()).get("profiles", user.userId);
      if (profile && !profile.isActive) {
        removeCachedProfile(user.userId);
        setUser(null);
        setSessionNeedsAttention(true);
        setError("Your church access has been disabled.");
        return;
      }
      if (!profile) return;
      const nextRole =
        profile.role === "admin" ? "admin" : "attendance_taker";
      setUser((current) => {
        if (
          !current ||
          (current.role === nextRole &&
            current.organizationId === profile.organizationId)
        ) {
          return current;
        }
        const nextUser = {
          ...current,
          role: nextRole,
          organizationId: profile.organizationId,
        } satisfies UserContext;
        writeCachedProfile(nextUser);
        return nextUser;
      });
    };

    const unsubscribe = subscribeToDataChanges(() => {
      void refreshCachedRole();
    });
    return unsubscribe;
  }, [user]);

  useEffect(() => {
    if (!session || !navigator.onLine) return;

    // Realtime/incremental sync keeps the cached profile current. A bounded
    // focus check remains as a safety net without fetching profile and
    // organization rows every time a user switches tabs or resumes the PWA.
    lastFocusAccessCheck.current = Date.now();
    const revalidateAccess = (force = false) => {
      if (!navigator.onLine) return;
      if (!shouldRevalidateAccess(lastFocusAccessCheck.current, force)) return;
      lastFocusAccessCheck.current = Date.now();
      void restoreSession(false);
    };
    const online = () => revalidateAccess(true);
    const focus = () => revalidateAccess(false);
    window.addEventListener("online", online);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focus);
    };
  }, [restoreSession, session]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!navigator.onLine) {
        const offlineError = new Error(
          "Your first sign-in on a device requires an internet connection. Returning users can reopen the app offline.",
        );
        setError(offlineError.message);
        throw offlineError;
      }
      setLoading(true);
      setError(null);
      try {
        const { data, error: signInError } =
          await getSupabaseClient().auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        await loadProfile(data.session);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Unable to sign in.",
        );
        setLoading(false);
        throw caught;
      }
    },
    [loadProfile],
  );

  const signOut = useCallback(async () => {
    setLoading(true);
    await getSupabaseClient().auth.signOut({ scope: "local" });
    setUser(null);
    setSession(null);
    setError(null);
    setSessionNeedsAttention(false);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({
      loading,
      session,
      user,
      error,
      signIn,
      signOut,
      refreshAccess,
      recoverSession,
      sessionNeedsAttention,
      authRevision,
    }),
    [
      loading,
      session,
      user,
      error,
      signIn,
      signOut,
      refreshAccess,
      recoverSession,
      sessionNeedsAttention,
      authRevision,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
