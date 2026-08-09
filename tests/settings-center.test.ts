import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_SETTINGS,
  type Organization,
  type UserContext,
} from "@/lib/domain";
import {
  getOrganizationSettings,
  saveOrganizationIdentity,
  saveOrganizationSettings,
} from "@/lib/repositories/settings-repository";
import {
  buildOrganizationExport,
  rowsToCsv,
} from "@/lib/settings/exports";
import {
  formatChurchDate,
  sortAttendanceMembers,
  validateApplicationSettings,
} from "@/lib/settings/settings";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  saveMember,
  saveService,
} from "@/lib/repositories/attendance-repository";

const organizationId = "20000000-0000-4000-8000-000000000080";
const otherOrganizationId = "20000000-0000-4000-8000-000000000081";
const admin: UserContext = {
  userId: "10000000-0000-4000-8000-000000000080",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};
const taker: UserContext = {
  ...admin,
  userId: "10000000-0000-4000-8000-000000000082",
  email: "volunteer@example.test",
  role: "attendance_taker",
};
const timestamp = "2026-07-29T12:00:00.000Z";

function organization(id = organizationId): Organization {
  return {
    id,
    name: id === organizationId ? "Fictional Community Church" : "Other Church",
    slug: id === organizationId ? "fictional-community" : "other-church",
    createdBy: admin.userId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

beforeEach(async () => {
  await clearLocalDatabase();
  const database = await getDatabase();
  await database.put("organizations", organization());
  await database.put("organizations", organization(otherOrganizationId));
});

describe("organization settings repository", () => {
  it("loads defaults, validates changes, and persists one offline settings record", async () => {
    const initial = await getOrganizationSettings(organizationId);
    expect(initial.settings.shortName).toBe("ALUPC");
    expect(initial.settings.timezone).toBe("America/Moncton");

    await saveOrganizationSettings(admin, {
      ...initial.settings,
      shortName: "FCCC",
      attendanceSort: "last_name",
    });
    await saveOrganizationSettings(admin, {
      ...initial.settings,
      shortName: "FCC",
      attendanceSort: "recently_added",
    });
    await closeLocalDatabaseConnection();

    const restored = await getOrganizationSettings(organizationId);
    expect(restored.settings.shortName).toBe("FCC");
    expect(restored.settings.attendanceSort).toBe("recently_added");
    const queued = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "organization_settings",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].recordId).toBe(organizationId);
  });

  it("rejects invalid settings and non-admin updates", async () => {
    const invalid = {
      ...DEFAULT_APPLICATION_SETTINGS,
      shortName: "",
    };
    expect(validateApplicationSettings(invalid)).not.toHaveLength(0);
    await expect(saveOrganizationSettings(admin, invalid)).rejects.toThrow(
      "short name",
    );
    await expect(
      saveOrganizationSettings(taker, DEFAULT_APPLICATION_SETTINGS),
    ).rejects.toThrow("Administrator");
  });

  it("updates organization identity without permitting organization reassignment", async () => {
    const updated = await saveOrganizationIdentity(admin, {
      name: "Fictional Church Updated",
      slug: "fictional-church-updated",
    });
    expect(updated.id).toBe(organizationId);
    expect(updated.name).toBe("Fictional Church Updated");
    await expect(
      (await getDatabase()).get("organizations", otherOrganizationId),
    ).resolves.toMatchObject({ name: "Other Church" });
    await expect(
      saveOrganizationIdentity(taker, {
        name: "Unauthorized",
        slug: "unauthorized",
      }),
    ).rejects.toThrow("Administrator");
  });
});

describe("workflow settings", () => {
  it("sorts attendance lists by configured first, last, or recently added order", async () => {
    const first = await saveMember(taker, {
      firstName: "Zara",
      lastName: "Amber",
    });
    const second = await saveMember(taker, {
      firstName: "Avery",
      lastName: "Stone",
    });
    first.createdAt = "2026-07-01T00:00:00.000Z";
    second.createdAt = "2026-07-02T00:00:00.000Z";
    expect(sortAttendanceMembers([first, second], "first_name")[0].id).toBe(
      second.id,
    );
    expect(sortAttendanceMembers([first, second], "last_name")[0].id).toBe(
      first.id,
    );
    expect(
      sortAttendanceMembers([first, second], "recently_added")[0].id,
    ).toBe(second.id);
  });

  it("keeps configurable service defaults on new records without changing history", async () => {
    const historical = await saveService(admin, {
      serviceDate: "2026-07-20",
      serviceType: "Sunday Morning",
      serviceTime: "10:30",
      status: "completed",
    });
    const settings = await getOrganizationSettings(organizationId);
    await saveOrganizationSettings(admin, {
      ...settings.settings,
      serviceTypes: settings.settings.serviceTypes.map((type) =>
        type.name === "Sunday Morning"
          ? { ...type, defaultTime: "11:00" }
          : type,
      ),
    });
    await expect(
      (await getDatabase()).get("services", historical.id),
    ).resolves.toMatchObject({ serviceTime: "10:30" });
  });

  it("uses the configured timezone and date format", () => {
    expect(
      formatChurchDate("2026-07-29", {
        timezone: "America/Moncton",
        dateFormat: "iso",
      }),
    ).toBe("2026-07-29");
    expect(
      formatChurchDate("2026-07-29", {
        timezone: "America/Moncton",
        dateFormat: "day_month_year",
      }),
    ).toContain("29");
  });
});

describe("secure exports", () => {
  it("exports only the active organization and excludes credentials", async () => {
    await saveMember(admin, { firstName: "Avery", lastName: "Stone" });
    await saveMember(
      { ...admin, organizationId: otherOrganizationId },
      { firstName: "Morgan", lastName: "Lane" },
    );
    const backup = await buildOrganizationExport(admin, "backup");
    expect(backup).toContain("Avery Stone");
    expect(backup).not.toContain("Morgan Lane");
    expect(backup).not.toMatch(/access_token|refresh_token|service.role|password/i);
    await expect(buildOrganizationExport(taker, "backup")).rejects.toThrow(
      "Administrator",
    );
  });

  it("escapes CSV values safely", () => {
    expect(rowsToCsv(["Name"], [['Avery "Ace", Stone']])).toBe(
      '"Name"\r\n"Avery ""Ace"", Stone"',
    );
  });

  it("exports service times using a readable 12-hour clock", async () => {
    await saveService(admin, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Evening",
      serviceTime: "18:00",
      status: "completed",
    });
    const csv = await buildOrganizationExport(admin, "services");
    expect(csv).toContain('"6:00 PM"');
    expect(csv).not.toContain('"18:00"');
  });
});

describe("settings navigation and database authorization", () => {
  const shell = readFileSync(resolve("components/shell/AppShell.tsx"), "utf8");
  const settingsPage = readFileSync(
    resolve("app/(protected)/settings/page.tsx"),
    "utf8",
  );
  const usersPage = readFileSync(
    resolve("app/(protected)/users/page.tsx"),
    "utf8",
  );
  const migration = readFileSync(
    resolve("supabase/migrations/202607290008_application_settings.sql"),
    "utf8",
  );

  it("shows Settings to both roles while keeping Users inside Admin settings", () => {
    expect(shell).toContain('{ href: "/settings", label: "Settings"');
    expect(shell).not.toContain('{ href: "/users", label: "Users"');
    expect(settingsPage).not.toContain("<AdminOnly>");
    expect(settingsPage).toContain("<SettingsCenter />");
    expect(usersPage).toContain('redirect("/settings?section=users")');
  });

  it("keeps organization controls Admin-only and removes dead controls", () => {
    const center = readFileSync(
      resolve("components/settings/SettingsCenter.tsx"),
      "utf8",
    );
    expect(center).toContain(
      'const attendanceTakerSectionIds: SettingsSection[] = [',
    );
    expect(center).toContain('"personal",\n  "sync",\n  "security"');
    expect(center).toContain('activeSection === "general" && admin');
    expect(center).toContain('activeSection === "users" && admin');
    expect(center).not.toContain('"showPresentCount", "Show present count"');
    expect(center).not.toContain('"showAbsentCount", "Show absent count"');
    expect(center).not.toContain('"showTotalMemberCount", "Show total member count"');
    expect(center).not.toContain('"requireVisitorName", "Require visitor name"');
    expect(center).not.toContain('"showVisitorsSeparately", "Show visitors separately"');
  });

  it("connects every retained workflow control to application behavior", () => {
    const manager = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );
    const calendar = readFileSync(
      resolve("components/services/ServicesCalendar.tsx"),
      "utf8",
    );
    expect(manager).toContain("modalSettings.defaultServiceStatus");
    for (const setting of [
      "allowAdminReopenCompleted",
      "confirmComplete",
      "confirmArchive",
      "attendanceSort",
      "showAttendanceTotals",
      "warnZeroAttendance",
      "showInactiveInAttendance",
      "visitorLabel",
      "allowVisitorNotes",
      "confirmVisitorRemoval",
      "includeVisitorsInTotal",
    ]) {
      expect(manager, `${setting} should have a real consumer`).toContain(
        `settings.${setting}`,
      );
    }
    expect(calendar).toContain('weekStart === "monday"');
  });

  it("uses organization-scoped read and admin-only write policies", () => {
    expect(migration).toContain(
      'create policy "Users read settings in their organization"',
    );
    expect(migration).toContain(
      "organization_id = public.current_organization_id()",
    );
    expect(migration).toContain("private.is_admin()");
    expect(migration).toContain("id = organization_id");
    expect(migration).not.toMatch(/disable row level security/i);
  });
});
