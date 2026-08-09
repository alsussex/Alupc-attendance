import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import type { UserContext } from "@/lib/domain";
import { saveThemePreference } from "@/lib/repositories/theme-repository";
import {
  applyTheme,
  getDeviceThemePreference,
  resolveTheme,
  setDeviceThemePreference,
  THEME_PREFERENCE_KEY,
} from "@/lib/theme/theme";
import { clearLocalDatabase, getDatabase } from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import { fromCloudRecord } from "@/lib/sync/serialization";
import { uploadPendingChanges, type UploadTarget } from "@/lib/sync/upload-service";

const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000910",
  organizationId: "20000000-0000-4000-8000-000000000910",
  email: "theme@example.test",
  role: "attendance_taker",
};

vi.mock("@/components/auth/AuthProvider", () => ({
  useAuth: () => ({ user: null }),
}));

beforeEach(async () => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  await clearLocalDatabase();
});

afterEach(() => cleanup());

describe("application theme support", () => {
  it("defaults new devices to System and resolves the operating-system theme", () => {
    expect(getDeviceThemePreference()).toBe("system");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("applies and persists explicit themes immediately", () => {
    setDeviceThemePreference("dark");
    applyTheme(getDeviceThemePreference(), false);
    expect(window.localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("offers accessible Light, Dark, and System controls", async () => {
    render(
      <ThemeProvider>
        <ThemeSwitcher />
      </ThemeProvider>,
    );
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute("data-theme", "dark"),
    );
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("stores profile changes locally, queues them, and uploads idempotently", async () => {
    const database = await getDatabase();
    await database.put("profiles", {
      id: user.userId,
      organizationId: user.organizationId,
      role: user.role,
      isActive: true,
      themePreference: "system",
      version: 4,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    await saveThemePreference(user, "dark");
    expect((await database.get("profiles", user.userId))?.themePreference).toBe(
      "dark",
    );
    expect(await getPendingChanges(user.organizationId)).toHaveLength(1);

    const uploaded: Array<Record<string, unknown>> = [];
    const target: UploadTarget = {
      async upsert(table, payload) {
        expect(table).toBe("profiles");
        uploaded.push(payload);
        return { version: 5, updatedAt: "2026-08-02T00:00:00.000Z" };
      },
    };
    expect((await uploadPendingChanges(user.organizationId, target)).uploaded).toBe(1);
    expect(uploaded[0]).toMatchObject({
      id: user.userId,
      organization_id: user.organizationId,
      theme_preference: "dark",
    });
    expect(await getPendingChanges(user.organizationId)).toHaveLength(0);
  });

  it("downloads valid cloud preferences and defaults legacy profiles safely", () => {
    const base = {
      id: user.userId,
      organization_id: user.organizationId,
      role: "attendance_taker",
      is_active: true,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    };
    expect(
      fromCloudRecord("profiles", { ...base, theme_preference: "light", version: 3 }),
    ).toMatchObject({ themePreference: "light", version: 3 });
    expect(fromCloudRecord("profiles", base)).toMatchObject({
      themePreference: "system",
    });
  });

  it("uses semantic theme tokens throughout custom component styles", () => {
    const css = readFileSync(resolve("app/globals.css"), "utf8");
    const componentStyles = css.slice(css.indexOf("* { box-sizing"));
    expect(css).toContain(':root[data-theme="dark"]');
    expect(componentStyles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(componentStyles).not.toMatch(/rgb\(\d/);
    expect(css).toContain("--canvas: #080d18");
    expect(css).toContain("--surface: #101827");
    expect(css).toContain("--sidebar-bg: #f6f8fc");
    expect(css).toContain("--sidebar-bg: #070c17");
    expect(css).toContain(':root:not([data-theme="dark"]) .sidebar');
    expect(css).toContain("--child-bg: #2d2416");
    expect(css).toContain("--child-text: #e9c37e");
  });

  it("adds an organization-safe self-only profile policy and trigger", () => {
    const migration = readFileSync(
      resolve("supabase/migrations/202607300008_user_theme_preference.sql"),
      "utf8",
    );
    expect(migration).toContain('create policy "Users update their own theme preference"');
    expect(migration).toContain("id = auth.uid()");
    expect(migration).toContain("organization_id = public.current_organization_id()");
    expect(migration).toContain("new.role is distinct from old.role");
    expect(migration).toContain("new.organization_id is distinct from old.organization_id");
    expect(migration).not.toContain("disable row level security");
  });
});
