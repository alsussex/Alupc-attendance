import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("authoritative product visual system", () => {
  it("loads after legacy globals without changing the Dashboard", () => {
    const layout = read("app/layout.tsx");
    const styles = read("app/product-system.css");

    expect(layout.indexOf('import "./product-system.css"')).toBeGreaterThan(
      layout.indexOf('import "./globals.css"'),
    );
    expect(styles).toContain("Authoritative product visual layer");
    expect(styles).not.toMatch(/\.dashboard-/);
  });

  it("uses semantic theme tokens instead of hard-coded component colors", () => {
    const styles = read("app/product-system.css");

    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toMatch(/rgb\(\d/);
    expect(styles).toContain("var(--surface)");
    expect(styles).toContain("var(--line)");
    expect(styles).toContain("var(--brand)");
  });

  it("scopes the shared layer to every major non-Dashboard workspace", () => {
    expect(read("components/services/ServiceManager.tsx")).toContain(
      "product-page services-page",
    );
    expect(read("components/people/PeopleDirectory.tsx")).toContain(
      "product-page people-page",
    );
    expect(read("components/reports/ReportsCenter.tsx")).toContain(
      "product-page reports-product-page",
    );
    expect(read("components/settings/SettingsCenter.tsx")).toContain(
      "product-page settings-product-page",
    );
    expect(read("components/users/UserManagement.tsx")).toContain(
      "product-subpage users-product-page",
    );
    expect(read("components/audit/AuditHistory.tsx")).toContain(
      "audit-product-page",
    );
  });

  it("keeps dense operational screens compact and scan-friendly", () => {
    const styles = read("app/product-system.css");

    expect(styles).toMatch(
      /\.attendance-metric\s*\{[^}]*min-height:\s*102px/,
    );
    expect(styles).toMatch(/\.report-data-table td,[\s\S]*padding:\s*\.72rem/);
    expect(styles).toMatch(/\.user-row\s*\{[^}]*min-height:\s*82px/);
    expect(styles).toMatch(
      /\.audit-entry-row\s*\{[^}]*padding:\s*\.15rem 0 1rem/,
    );
  });

  it("separates adjacent routine, lifecycle, and destructive actions", () => {
    const people = read("components/people/PeopleDirectory.tsx");
    const services = read("components/services/ServiceManager.tsx");
    const styles = read("app/product-system.css");

    expect(people).toContain("people-management-actions");
    expect(people).toContain("routine-actions");
    expect(people).toContain("destructive-actions");
    expect(services).toContain("service-workflow-actions");
    expect(services).toContain("service-management-actions");
    expect(styles).toContain("--product-action-gap: .75rem");
    expect(styles).toContain("--product-touch-gap: .9rem");
    expect(styles).toMatch(/@media \(max-width: 680px\)[\s\S]*min-height:\s*48px/);
    expect(styles).toMatch(/@media \(max-width: 430px\)[\s\S]*flex-direction:\s*column/);
  });

  it("provides consistent focus, reduced-motion, dialog, and feedback states", () => {
    const styles = read("app/product-system.css");

    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".modal-backdrop");
    expect(styles).toContain(".loading-skeleton");
    expect(styles).toContain(".toast");
  });
});
