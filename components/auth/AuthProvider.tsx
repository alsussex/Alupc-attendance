"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
}

const AuthContext = createContext<AuthState | null>(null);

function profileCacheKey(userId: string) {
  return `church-attendance-profile:${userId}`;
}

function readCachedProfile(userId: string) {
  const value = localStorage.getItem(profileCacheKey(userId));
  if (!value) return null;
  const cached = JSON.parse(value) as UserContext;
  return {
    ...cached,
    role: cached.role === "admin" ? "admin" : "attendance_taker",
  } satisfies UserContext;
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

  const loadProfile = useCallback(async (nextSession: Session | null) => {
    setSession(nextSession);
    if (!nextSession) {
      setUser(null);
      setLoading(false);
      return;
    }

    const authUser = nextSession.user;
    const cached = readCachedProfile(authUser.id);
    if (!navigator.onLine && cached) {
      setUser(cached);
      setError(null);
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();
    const { data, error: profileError } = await supabase
      .from("profiles")
      .select("organization_id, role, is_active")
      .eq("id", authUser.id)
      .single();

    if (profileError || !data?.organization_id || !data.is_active) {
      const connectionFailure =
        !navigator.onLine ||
        /fetch|network|connection/i.test(profileError?.message ?? "");
      if (cached && connectionFailure) {
        setUser(cached);
        setError(null);
      } else {
        localStorage.removeItem(profileCacheKey(authUser.id));
        setUser(null);
        setError(
          "Your account is disabled or is not connected to this church organization.",
        );
      }
      setLoading(false);
      return;
    }

    const nextUser: UserContext = {
      userId: authUser.id,
      organizationId: data.organization_id,
      email: authUser.email ?? "",
      role: data.role === "admin" ? "admin" : "attendance_taker",
    };
    localStorage.setItem(profileCacheKey(authUser.id), JSON.stringify(nextUser));
    setUser(nextUser);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabaseClient();
    void supabase.auth.getSession().then(({ data }) => loadProfile(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void loadProfile(nextSession);
    });
    return () => subscription.unsubscribe();
  }, [configured, loadProfile]);

  useEffect(() => {
    if (!user) return;

    const refreshCachedRole = async () => {
      const profile = await (await getDatabase()).get("profiles", user.userId);
      if (!profile?.isActive) return;
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
      if (navigator.onLine) void loadProfile(session);
    };
    window.addEventListener("online", revalidateAccess);
    window.addEventListener("focus", revalidateAccess);
    return () => {
      window.removeEventListener("online", revalidateAccess);
      window.removeEventListener("focus", revalidateAccess);
    };
  }, [loadProfile, session]);

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
    await getSupabaseClient().auth.signOut();
    setUser(null);
    setSession(null);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({ loading, session, user, error, signIn, signOut }),
    [loading, session, user, error, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
