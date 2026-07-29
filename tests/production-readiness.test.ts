import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const environmentExample = readFileSync(resolve(".env.example"), "utf8");
const serviceWorker = readFileSync(resolve("public/sw.js"), "utf8");
const developmentSeed = readFileSync(
  resolve("lib/seed/development-seed.ts"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(resolve("public/manifest.webmanifest"), "utf8"),
) as { icons: Array<{ sizes: string }> };

describe("production deployment safeguards", () => {
  it("keeps the committed environment template non-production", () => {
    expect(environmentExample).toContain(
      "NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co",
    );
    expect(environmentExample).toContain(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key",
    );
    expect(environmentExample).toContain(
      "NEXT_PUBLIC_ENABLE_DEMO_SEED=false",
    );
    expect(environmentExample).toContain(
      "SUPABASE_SERVICE_ROLE_KEY=your-service-role-key",
    );
    expect(environmentExample).not.toMatch(/eyJ[A-Za-z0-9_-]{40,}/);
  });

  it("requires both development mode and the explicit seed flag", () => {
    expect(developmentSeed).toContain(
      'process.env.NODE_ENV !== "development"',
    );
    expect(developmentSeed).toContain(
      'process.env.NEXT_PUBLIC_ENABLE_DEMO_SEED !== "true"',
    );
  });

  it("does not intercept Supabase or other cross-origin requests", () => {
    expect(serviceWorker).toContain(
      "if (url.origin !== self.location.origin || url.pathname === \"/sw.js\") return;",
    );
  });

  it("expires old application-shell caches without deleting IndexedDB", () => {
    expect(serviceWorker).toContain("key.startsWith(CACHE_PREFIX)");
    expect(serviceWorker).not.toContain("indexedDB.deleteDatabase");
  });

  it("provides standard install icons", () => {
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
  });
});
