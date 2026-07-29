import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    "supabase/migrations/202607290007_allow_privileged_dashboard_administration.sql",
  ),
  "utf8",
);

function functionBody(name: string, nextName?: string) {
  const start = migration.indexOf(
    `create or replace function private.${name}`,
  );
  const end = nextName
    ? migration.indexOf(`create or replace function private.${nextName}`, start)
    : migration.length;
  return migration.slice(start, end);
}

describe("privileged database administration context", () => {
  const contextHelper = functionBody(
    "is_privileged_database_context()",
    "enforce_people_role()",
  );
  const peopleTrigger = functionBody(
    "enforce_people_role()",
    "enforce_service_role()",
  );
  const serviceTrigger = functionBody("enforce_service_role()");

  it("allows the service role and direct database sessions without an Auth JWT", () => {
    expect(contextHelper).toContain("auth.role() = 'service_role'");
    expect(contextHelper).toContain("auth.uid() is null");
  });

  it("does not treat authenticated or anonymous API requests as privileged", () => {
    expect(contextHelper).toContain(
      "auth.role() is distinct from 'authenticated'",
    );
    expect(contextHelper).toContain("auth.role() is distinct from 'anon'");
    expect(contextHelper).not.toContain("auth.uid() is null\n$$");
  });

  it("keeps active-profile and Attendance Taker enforcement for app users", () => {
    for (const trigger of [peopleTrigger, serviceTrigger]) {
      expect(trigger).toContain(
        "if private.is_privileged_database_context() then",
      );
      expect(trigger).toContain(
        "actor_role := private.current_profile_role()",
      );
      expect(trigger).toContain(
        "raise exception 'Active church access is required'",
      );
    }
    expect(peopleTrigger).toContain(
      "Attendance takers cannot delete church members",
    );
    expect(peopleTrigger).toContain(
      "Attendance takers may edit member names but cannot change lifecycle fields",
    );
    expect(serviceTrigger).toContain(
      "Attendance takers cannot delete services",
    );
  });

  it("preserves people organization and creation ownership immutability", () => {
    expect(peopleTrigger).toContain(
      "new.organization_id is distinct from old.organization_id",
    );
    expect(peopleTrigger).toContain(
      "new.person_type is distinct from old.person_type",
    );
    expect(peopleTrigger).toContain(
      "new.created_by is distinct from old.created_by",
    );
    expect(peopleTrigger).toContain(
      "new.created_at is distinct from old.created_at",
    );
  });

  it("does not change RLS, grants, policies, or the last-admin integrity trigger", () => {
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/\bcreate policy\b/i);
    expect(migration).not.toMatch(/\bdrop policy\b/i);
    expect(migration).not.toMatch(/\bgrant\s+(select|insert|update|delete|all)\b/i);
    expect(migration).not.toContain("protect_last_admin");
    expect(migration).not.toContain("service_role key");
  });

  it("keeps all trigger helpers private", () => {
    expect(migration).toContain(
      "revoke all on function private.is_privileged_database_context() from public",
    );
    expect(migration).toContain(
      "revoke all on function private.enforce_people_role() from public",
    );
    expect(migration).toContain(
      "revoke all on function private.enforce_service_role() from public",
    );
  });
});
