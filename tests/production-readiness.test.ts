import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const environmentExample = readFileSync(resolve(".env.example"), "utf8");
const serviceWorker = readFileSync(resolve("public/sw.js"), "utf8");
const serviceWorkerRegistration = readFileSync(
  resolve("components/pwa/ServiceWorkerRegistration.tsx"),
  "utf8",
);
const rootLayout = readFileSync(resolve("app/layout.tsx"), "utf8");
const developmentSeed = readFileSync(
  resolve("lib/seed/development-seed.ts"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(resolve("public/manifest.webmanifest"), "utf8"),
) as {
  name: string;
  short_name: string;
  icons: Array<{ src: string; sizes: string; purpose: string }>;
};

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

  it("activates fresh UI assets and reloads an installed PWA once", () => {
    expect(serviceWorker).toContain('`${CACHE_PREFIX}v7`');
    expect(serviceWorker).toContain('["script", "style"]');
    expect(serviceWorker).toContain("networkFirst(event.request)");
    expect(serviceWorker).toContain('event.data?.type === "SKIP_WAITING"');
    expect(serviceWorkerRegistration).toContain('"controllerchange"');
    expect(serviceWorkerRegistration).toContain("window.location.reload()");
    expect(serviceWorkerRegistration).toContain('type: "SKIP_WAITING"');
  });

  it("provides ALUPC install branding and standard plus maskable icons", async () => {
    expect(manifest.name).toBe("ALUPC Attendance");
    expect(manifest.short_name).toBe("ALUPC Attendance");
    expect(rootLayout).toContain('applicationName: "ALUPC Attendance"');
    expect(rootLayout).toContain('title: "ALUPC Attendance"');
    expect(rootLayout).toContain('url: "/apple-touch-icon.png"');
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
      "512x512",
    ]);
    expect(manifest.icons[2]).toMatchObject({
      src: "/icon-maskable-512.png",
      purpose: "maskable",
    });
    for (const [path, size] of [
      ["public/icon-192.png", 192],
      ["public/icon-512.png", 512],
      ["public/icon-maskable-512.png", 512],
      ["public/apple-touch-icon.png", 180],
      ["public/favicon-32.png", 32],
    ] as const) {
      const png = readFileSync(resolve(path));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(existsSync(resolve("public/favicon.svg"))).toBe(false);
    expect(serviceWorker).toContain('"/icon-maskable-512.png"');
    expect(serviceWorker).toContain('"/apple-touch-icon.png"');
  });
});
