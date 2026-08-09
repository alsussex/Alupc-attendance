import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTENDANCE_PREFERENCES_KEY,
  getAttendanceExperiencePreferences,
  preferredAttendanceStartingTab,
  rememberAttendanceTab,
  saveAttendanceExperiencePreferences,
  subscribeToAttendanceExperiencePreferences,
} from "@/lib/settings/attendance-preferences";
import { syncDiagnosticDetails } from "@/lib/sync/errors";
import { settingsSectionIdsForRole } from "@/components/settings/SettingsCenter";

beforeEach(() => {
  window.localStorage.clear();
  saveAttendanceExperiencePreferences({
    defaultTab: "members",
    rememberLastTab: true,
    lastTab: "members",
    density: "comfortable",
  });
});

describe("personal attendance settings", () => {
  it("gives Attendance Takers only personal, sync, and account settings", () => {
    expect(settingsSectionIdsForRole("attendance_taker")).toEqual([
      "personal",
      "sync",
      "security",
    ]);
    expect(settingsSectionIdsForRole("admin")).toContain("general");
    expect(settingsSectionIdsForRole("admin")).toContain("users");
  });

  it("persists a device-local default tab and applies it when memory is off", () => {
    saveAttendanceExperiencePreferences({
      defaultTab: "visitors",
      rememberLastTab: false,
    });
    expect(preferredAttendanceStartingTab()).toBe("visitors");
    expect(
      JSON.parse(
        window.localStorage.getItem(ATTENDANCE_PREFERENCES_KEY) ?? "{}",
      ),
    ).toMatchObject({ defaultTab: "visitors", rememberLastTab: false });
  });

  it("remembers the last Members or Visitors tab when enabled", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToAttendanceExperiencePreferences(listener);
    rememberAttendanceTab("visitors");
    expect(getAttendanceExperiencePreferences().lastTab).toBe("visitors");
    expect(preferredAttendanceStartingTab()).toBe("visitors");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("does not overwrite the remembered tab when remembering is disabled", () => {
    saveAttendanceExperiencePreferences({
      defaultTab: "members",
      lastTab: "members",
      rememberLastTab: false,
    });
    rememberAttendanceTab("visitors");
    expect(getAttendanceExperiencePreferences().lastTab).toBe("members");
  });

  it("persists compact density and connects it to the attendance workspace", () => {
    saveAttendanceExperiencePreferences({ density: "compact" });
    expect(getAttendanceExperiencePreferences().density).toBe("compact");
    const manager = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const styles = readFileSync(resolve("app/product-system.css"), "utf8");
    expect(manager).toContain('attendancePreferences.density === "compact"');
    expect(styles).toContain(".attendance-density-compact .member-card-grid");
  });
});

describe("Settings troubleshooting", () => {
  it("shows useful sync codes while redacting secrets", () => {
    const detail = syncDiagnosticDetails(
      "42703: profiles.version missing; Authorization=Bearer abc.def.ghi password=hunter2",
    );
    expect(detail).toMatchObject({ code: "42703" });
    expect(detail?.message).toContain("profiles.version missing");
    expect(detail?.message).not.toContain("abc.def.ghi");
    expect(detail?.message).not.toContain("hunter2");
  });

  it("resets only local storage and then downloads a fresh copy", () => {
    const center = readFileSync(
      resolve("components/settings/SettingsCenter.tsx"),
      "utf8",
    );
    expect(center).toContain("await clearLocalDatabase()");
    expect(center).toContain("await synchronization.syncNow()");
    expect(center).toContain("Cloud data will not be deleted");
    expect(center).not.toMatch(/from\(["'](?:people|services|profiles)["']\)\.delete/);
  });
});
