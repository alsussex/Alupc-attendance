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
    const cached = localStorage.getItem(profileCacheKey(authUser.id));
    if (!navigator.onLine && cached) {
      setUser(JSON.parse(cached) as UserContext);
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();
    const { data, error: profileError } = await supabase
      .from("profiles")
      .select("organization_id")
      .eq("id", authUser.id)
      .single();

    if (profileError || !data?.organization_id) {
      if (cached) {
        setUser(JSON.parse(cached) as UserContext);
      } else {
        setError(
          "Your account is signed in but is not connected to a church organization.",
        );
      }
      setLoading(false);
      return;
    }

    const nextUser: UserContext = {
      userId: authUser.id,
      organizationId: data.organization_id,
      email: authUser.email ?? "",
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

  const signIn = useCallback(
    async (email: string, password: string) => {
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
