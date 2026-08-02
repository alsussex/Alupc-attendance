import type { ThemePreference } from "@/lib/domain";

export const THEME_PREFERENCE_KEY = "church-attendance:theme-preference";
const THEME_PREFERENCE_EVENT = "church-attendance:theme-preference-change";
let inMemoryPreference: ThemePreference = "system";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function getDeviceThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    inMemoryPreference = isThemePreference(stored) ? stored : "system";
  } catch {
    // Continue with the in-memory value when storage is unavailable.
  }
  return inMemoryPreference;
}

export function setDeviceThemePreference(preference: ThemePreference) {
  if (typeof window === "undefined") return;
  inMemoryPreference = preference;
  try {
    window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // The current page can still change theme without persistent storage.
  }
  window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT));
}

export function subscribeToDeviceTheme(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(THEME_PREFERENCE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(THEME_PREFERENCE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
) {
  return preference === "system"
    ? systemDark
      ? "dark"
      : "light"
    : preference;
}

export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(preference, systemDark);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  themeColor?.setAttribute("content", resolved === "dark" ? "#101815" : "#f4f7f5");
}

export const themeBootstrapScript = `(() => {
  try {
    const stored = localStorage.getItem('${THEME_PREFERENCE_KEY}');
    const preference = stored === 'light' || stored === 'dark' ? stored : 'system';
    const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.themePreference = 'system';
  }
})();`;
