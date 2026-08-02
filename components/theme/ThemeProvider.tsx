"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { ThemePreference } from "@/lib/domain";
import {
  loadThemePreference,
  saveThemePreference,
} from "@/lib/repositories/theme-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import {
  applyTheme,
  getDeviceThemePreference,
  resolveTheme,
  setDeviceThemePreference,
  subscribeToDeviceTheme,
} from "@/lib/theme/theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: "light" | "dark";
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemUsesDarkTheme() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const preference = useSyncExternalStore(
    subscribeToDeviceTheme,
    getDeviceThemePreference,
    () => "system" as const,
  );
  const [systemDark, setSystemDark] = useState(systemUsesDarkTheme);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    applyTheme(preference, systemDark);
  }, [preference, systemDark]);

  useEffect(() => {
    if (!user) return;
    const refresh = async () => {
      const synced = await loadThemePreference(user);
      if (synced && synced !== getDeviceThemePreference()) {
        setDeviceThemePreference(synced);
      }
    };
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [user]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setDeviceThemePreference(next);
      if (user) void saveThemePreference(user, next);
    },
    [user],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme: resolveTheme(preference, systemDark),
      setPreference,
    }),
    [preference, setPreference, systemDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
