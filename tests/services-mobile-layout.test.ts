import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Services mobile filter layout", () => {
  const styles = readFileSync(resolve("app/globals.css"), "utf8");
  const productStyles = readFileSync(resolve("app/product-system.css"), "utf8");
  const serviceManager = readFileSync(
    resolve("components/services/ServiceManager.tsx"),
    "utf8",
  );
  const mobileLayer = styles.slice(styles.lastIndexOf("@media (max-width: 560px)"));

  it("stacks the toolbar without allowing intrinsic control widths to overflow", () => {
    expect(mobileLayer).toContain(".service-directory-toolbar {");
    expect(mobileLayer).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(mobileLayer).toContain(".service-directory-toolbar > * {");
    expect(mobileLayer).toContain("max-width: 100%;");
    expect(mobileLayer).toContain(".service-directory-toolbar .search-field input {");
    expect(mobileLayer).toContain("min-width: 0;");
  });

  it("keeps status filters usable in one equal-width row and stacks advanced filters", () => {
    expect(mobileLayer).toContain("grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(mobileLayer).toContain(".service-filter-disclosure { width: 100%; }");
    expect(mobileLayer).toMatch(
      /\.service-advanced-filters\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(mobileLayer).toContain(".service-advanced-filters select,");
  });

  it("keeps row metadata on two lines and attendance columns stable", () => {
    expect(serviceManager).toContain(
      'className="service-directory-updated"',
    );
    expect(serviceManager).toContain(
      "<span>Updated {formatDateTime(item.service.updatedAt)}</span>",
    );
    expect(serviceManager).toContain(
      "<span>By {item.lastEditor}</span>",
    );
    expect(productStyles).toContain(
      "grid-template-columns: 64px minmax(0, 1fr) 190px 130px 20px;",
    );
    expect(productStyles).toContain(".service-directory-counts {\n  width: 190px;");
    expect(productStyles).toContain("overflow-wrap: anywhere;");
  });
});
