import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(path), "utf8");
}

describe("open application page structure", () => {
  it("composes the dashboard without card grids or nested dashboard surfaces", () => {
    const dashboard = source("components/dashboard/Dashboard.tsx");
    expect(dashboard).toContain('className="dashboard-home-layout"');
    expect(dashboard).toContain('className="dashboard-current-service"');
    expect(dashboard).toContain('className="dashboard-recent-services"');
    expect(dashboard).not.toContain("dashboard-action-list");
    expect(dashboard).not.toContain("dashboard-stat-strip");
    expect(dashboard).not.toContain("dashboard-action-card");
    expect(dashboard).not.toContain("dashboard-metric-card");
    expect(dashboard).not.toContain("dashboard-surface");
    expect(dashboard).not.toContain("dashboard-service-card-grid");
  });

  it("uses page-native people, services, and user directories", () => {
    const people = source("components/people/PeopleDirectory.tsx");
    const services = source("components/services/ServiceManager.tsx");
    const users = source("components/users/UserManagement.tsx");

    expect(people).toContain('className="people-directory-workspace"');
    expect(people).not.toContain('<section className="panel">');
    expect(services).toContain('className="service-directory-toolbar"');
    expect(services).toContain('className="attendance-people-workspace"');
    expect(services).not.toContain("panel service-directory-toolbar");
    expect(services).not.toContain("panel attendance-people-workspace");
    expect(users).toContain('className="users-directory"');
    expect(users).not.toContain("panel users-panel");
  });

  it("renders settings and audit history as open divided sections", () => {
    const settings = source("components/settings/SettingsCenter.tsx");
    const exportSection = source(
      "components/settings/MonthlyAttendanceExport.tsx",
    );
    const archiveSection = source(
      "components/settings/ArchivedServicesManager.tsx",
    );
    const audit = source("components/audit/AuditHistory.tsx");

    expect(settings).toContain('className="settings-section"');
    expect(settings).toContain('className="settings-quick-links"');
    expect(settings).not.toContain("panel settings-card");
    expect(exportSection).toContain("settings-section monthly-attendance-export-card");
    expect(archiveSection).toContain("settings-section archived-services-settings");
    expect(audit).toContain('className="audit-entry-row"');
    expect(audit).not.toContain('className="audit-entry"');
  });
});
