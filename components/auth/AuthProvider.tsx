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
  sessionNeedsAttention: boolean;
  authRevision: number;
}

const AuthContext = createContext<AuthState | null>(null);

function profileCacheKey(userId: string) {
  return `church-attendance-profile:${userId}`;
}

function readCachedProfile(userId: string) {
  const value = localStorage.getItem(profileCacheKey(userId));
  if (!value) return null;
  try {
    const cached = JSON.parse(value) as UserContext;
    if (!cached.organizationId || cached.userId !== userId) return null;
    return {
      ...cached,
      role: cached.role === "admin" ? "admin" : "attendance_taker",
    } satisfies UserContext;
  } catch {
    localStorage.removeItem(profileCacheKey(userId));
    return null;
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
  const refreshPromise = useRef<Promise<UserContext | null> | null>(null);

  const loadProfile = useCallback(async (
    nextSession: Session | null,
  ): Promise<UserContext | null> => {
    setSession(nextSession);
    if (!nextSession) {
      setUser(null);
      setError(null);
      setSessionNeedsAttention(false);
      setLoading(false);
      return null;
    }

    const authUser = nextSession.user;
    const cached = readCachedProfile(authUser.id);
    if (!navigator.onLine && cached) {
      setUser(cached);
      setError(null);
      setSessionNeedsAttention(false);
      setLoading(false);
      return cached;
    }

    const supabase = getSupabaseClient();
    const { data, error: profileError } = await supabase
      .from("profiles")
      .select("organization_id, display_name, role, is_active, created_at, updated_at")
      .eq("id", authUser.id)
      .single();

    const { data: organization, error: organizationError } = data?.organization_id
      ? await supabase
          .from("organizations")
          .select("id, name, slug, created_by, created_at, updated_at, version")
          .eq("id", data.organization_id)
          .single()
      : { data: null, error: null };

    if (
      profileError ||
      organizationError ||
      !data?.organization_id ||
      !data.is_active ||
      !organization
    ) {
      const connectionFailure =
        !navigator.onLine ||
        /fetch|network|connection|timeout/i.test(
          `${profileError?.message ?? ""} ${organizationError?.message ?? ""}`,
        );
      if (cached && connectionFailure) {
        setUser(cached);
        setError(null);
        setSessionNeedsAttention(false);
        setLoading(false);
        return cached;
      } else {
        localStorage.removeItem(profileCacheKey(authUser.id));
        setUser(null);
        setSessionNeedsAttention(true);
        setError(
          "Your account is disabled or is not connected to this church organization.",
        );
      }
      setLoading(false);
      return null;
    }

    const nextUser: UserContext = {
      userId: authUser.id,
      organizationId: data.organization_id,
      email: authUser.email ?? "",
      role: data.role === "admin" ? "admin" : "attendance_taker",
    };
    const database = await getDatabase();
    await Promise.all([
      database.put("profiles", {
        id: authUser.id,
        organizationId: data.organization_id,
        displayName: data.display_name ?? undefined,
        role: nextUser.role,
        isActive: data.is_active,
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
    localStorage.setItem(profileCacheKey(authUser.id), JSON.stringify(nextUser));
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
    setLoading(false);
    return nextUser;
  }, []);

  const refreshAccess = useCallback(() => {
    if (refreshPromise.current) return refreshPromise.current;
    const refresh = (async () => {
      if (!navigator.onLine) {
        if (session) return readCachedProfile(session.user.id);
        return null;
      }
      const { data, error: refreshError } =
        await getSupabaseClient().auth.refreshSession();
      if (refreshError || !data.session) {
        setSessionNeedsAttention(true);
        const temporary =
          !navigator.onLine ||
          /fetch|network|connection|timeout/i.test(
            refreshError?.message ?? "",
          );
        if (temporary) {
          setError(
            "Your sign-in could not be refreshed yet. Saved work remains on this device and recovery will retry automatically.",
          );
        } else {
          setUser(null);
          setError("Your sign-in needs attention. Please sign in again.");
        }
        return null;
      }
      return loadProfile(data.session);
    })().finally(() => {
      refreshPromise.current = null;
    });
    refreshPromise.current = refresh;
    return refresh;
  }, [loadProfile, session]);

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabaseClient();
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session || !navigator.onLine) {
        await loadProfile(data.session);
        return;
      }
      const { data: refreshed, error: refreshError } =
        await supabase.auth.refreshSession();
      if (
        refreshError &&
        !/fetch|network|connection|timeout/i.test(refreshError.message)
      ) {
        setSession(data.session);
        setUser(null);
        setSessionNeedsAttention(true);
        setError("Your sign-in needs attention. Please sign in again.");
        setLoading(false);
        return;
      }
      await loadProfile(
        !refreshError && refreshed.session
          ? refreshed.session
          : data.session,
      );
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "SIGNED_OUT") {
        void loadProfile(null);
        return;
      }
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        window.setTimeout(
          () =>
            void loadProfile(nextSession).then(() =>
              setAuthRevision((current) => current + 1),
            ),
          0,
        );
      }
    });
    return () => subscription.unsubscribe();
  }, [configured, loadProfile]);

  useEffect(() => {
    if (!user) return;

    const refreshCachedRole = async () => {
      const profile = await (await getDatabase()).get("profiles", user.userId);
      if (profile && !profile.isActive) {
        localStorage.removeItem(profileCacheKey(user.userId));
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
        localStorage.setItem(
          profileCacheKey(current.userId),
          JSON.stringify(nextUser),
        );
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

    const revalidateAccess = () => {
      if (navigator.onLine) void refreshAccess();
    };
    window.addEventListener("online", revalidateAccess);
    window.addEventListener("focus", revalidateAccess);
    return () => {
      window.removeEventListener("online", revalidateAccess);
      window.removeEventListener("focus", revalidateAccess);
    };
  }, [refreshAccess, session]);

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
