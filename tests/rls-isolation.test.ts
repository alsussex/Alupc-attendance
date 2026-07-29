import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/202607290001_stage_one.sql"),
  "utf8",
);
const timestampMigration = readFileSync(
  resolve("supabase/migrations/202607290002_sync_timestamps.sql"),
  "utf8",
);

describe("organization RLS migration", () => {
  it("enables RLS on every synchronized table", () => {
    for (const table of [
      "organizations",
      "profiles",
      "people",
      "services",
      "service_attendance",
      "service_visitors",
    ]) {
      expect(migration).toContain(
        `alter table public.${table} enable row level security;`,
      );
    }
  });

  it("scopes synchronized data policies to the authenticated organization", () => {
    expect(migration).not.toMatch(/to anon/i);
    expect(
      migration.match(
        /organization_id = public\.current_organization_id\(\)/g,
      )?.length,
    ).toBeGreaterThanOrEqual(14);
    expect(migration).toContain(
      "where id = auth.uid() and is_active = true",
    );
  });

  it("assigns trusted synchronization timestamps on insert and update", () => {
    for (const table of [
      "organizations",
      "profiles",
      "people",
      "services",
      "service_attendance",
      "service_visitors",
    ]) {
      expect(timestampMigration).toContain(
        `before insert or update on public.${table}`,
      );
    }
  });
});
