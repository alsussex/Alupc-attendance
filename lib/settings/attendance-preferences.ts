export type PersonalAttendanceTab = "members" | "visitors";
export type AttendanceDisplayDensity = "comfortable" | "compact";

export interface AttendanceExperiencePreferences {
  defaultTab: PersonalAttendanceTab;
  rememberLastTab: boolean;
  lastTab: PersonalAttendanceTab;
  density: AttendanceDisplayDensity;
}

export const ATTENDANCE_PREFERENCES_KEY =
  "church-attendance:attendance-experience";
const ATTENDANCE_PREFERENCES_EVENT =
  "church-attendance:attendance-experience-change";

const defaults: AttendanceExperiencePreferences = {
  defaultTab: "members",
  rememberLastTab: true,
  lastTab: "members",
  density: "comfortable",
};

let memoryPreferences = { ...defaults };
let memorySerialized: string | null = null;

function validTab(value: unknown): value is PersonalAttendanceTab {
  return value === "members" || value === "visitors";
}

function validDensity(value: unknown): value is AttendanceDisplayDensity {
  return value === "comfortable" || value === "compact";
}

function normalizePreferences(
  value?: Partial<AttendanceExperiencePreferences> | null,
): AttendanceExperiencePreferences {
  return {
    defaultTab: validTab(value?.defaultTab) ? value.defaultTab : defaults.defaultTab,
    rememberLastTab:
      typeof value?.rememberLastTab === "boolean"
        ? value.rememberLastTab
        : defaults.rememberLastTab,
    lastTab: validTab(value?.lastTab) ? value.lastTab : defaults.lastTab,
    density: validDensity(value?.density) ? value.density : defaults.density,
  };
}

export function getAttendanceExperiencePreferences() {
  if (typeof window === "undefined") return defaults;
  try {
    const stored = window.localStorage.getItem(ATTENDANCE_PREFERENCES_KEY);
    if (stored === memorySerialized) return memoryPreferences;
    memoryPreferences = normalizePreferences(
      stored ? (JSON.parse(stored) as Partial<AttendanceExperiencePreferences>) : null,
    );
    memorySerialized = stored;
  } catch {
    memoryPreferences = normalizePreferences(memoryPreferences);
  }
  return memoryPreferences;
}

export function getServerAttendanceExperiencePreferences() {
  return defaults;
}

export function saveAttendanceExperiencePreferences(
  patch: Partial<AttendanceExperiencePreferences>,
) {
  if (typeof window === "undefined") return defaults;
  const next = normalizePreferences({
    ...getAttendanceExperiencePreferences(),
    ...patch,
  });
  memoryPreferences = next;
  memorySerialized = JSON.stringify(next);
  try {
    window.localStorage.setItem(ATTENDANCE_PREFERENCES_KEY, memorySerialized);
  } catch {
    // The current session still respects the in-memory preference.
  }
  window.dispatchEvent(new Event(ATTENDANCE_PREFERENCES_EVENT));
  return next;
}

export function subscribeToAttendanceExperiencePreferences(
  listener: () => void,
) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(ATTENDANCE_PREFERENCES_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(ATTENDANCE_PREFERENCES_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function preferredAttendanceStartingTab() {
  const preferences = getAttendanceExperiencePreferences();
  return preferences.rememberLastTab
    ? preferences.lastTab
    : preferences.defaultTab;
}

export function rememberAttendanceTab(tab: PersonalAttendanceTab) {
  const preferences = getAttendanceExperiencePreferences();
  if (!preferences.rememberLastTab || preferences.lastTab === tab) return;
  saveAttendanceExperiencePreferences({ lastTab: tab });
}
