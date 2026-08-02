export const SIDEBAR_PREFERENCE_KEY =
  "church-attendance:sidebar-collapsed";
const SIDEBAR_PREFERENCE_EVENT = "church-attendance:sidebar-preference";
let inMemoryPreference = false;

export function getSidebarCollapsedPreference() {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY);
    inMemoryPreference = stored === "true";
    return inMemoryPreference;
  } catch {
    return inMemoryPreference;
  }
}

export function setSidebarCollapsedPreference(collapsed: boolean) {
  if (typeof window === "undefined") return;
  inMemoryPreference = collapsed;
  try {
    window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(collapsed));
  } catch {
    // The sidebar still works when device storage is unavailable.
  }
  window.dispatchEvent(new Event(SIDEBAR_PREFERENCE_EVENT));
}

export function subscribeToSidebarPreference(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(SIDEBAR_PREFERENCE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(SIDEBAR_PREFERENCE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
