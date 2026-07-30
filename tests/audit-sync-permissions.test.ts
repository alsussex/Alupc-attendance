import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    rpc: rpcMock,
    from: fromMock,
  }),
}));

import { createSupabaseUploadTarget } from "@/lib/sync/upload-service";

const organizationId = "10000000-0000-4000-8000-000000000001";
const auditId = "90000000-0000-4000-8000-000000000001";
const mutationToken = "91000000-0000-4000-8000-000000000001";

function auditPayload(role: "admin" | "attendance_taker") {
  return {
    id: auditId,
    organization_id: organizationId,
    entity_type: "attendance",
    entity_id: "50000000-0000-4000-8000-000000000001",
    action: "marked_present",
    user_id: "20000000-0000-4000-8000-000000000001",
    user_display_name: "Fictional Volunteer",
    role,
    occurred_at: "2026-07-30T14:00:00.000Z",
    details: { name: "Jordan Example" },
    created_at: "2026-07-30T14:00:00.000Z",
    updated_at: "2026-07-30T14:00:00.000Z",
  };
}

describe("append-only audit synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({
      data: {
        version: 1,
        updated_at: "2026-07-30T14:00:01.000Z",
      },
      error: null,
    });
  });

  it.each(["admin", "attendance_taker"] as const)(
    "uses the authenticated append RPC for %s history without reading or upserting the table",
    async (role) => {
      const target = createSupabaseUploadTarget();
      const receipt = await target.upsert(
        "audit_log",
        auditPayload(role),
        "id",
        {
          organizationId,
          recordId: auditId,
          mutationToken,
        },
      );

      expect(rpcMock).toHaveBeenCalledWith("append_audit_log_entry", {
        p_entry: auditPayload(role),
        p_mutation_id: mutationToken,
      });
      expect(fromMock).not.toHaveBeenCalled();
      expect(receipt).toEqual({
        version: 1,
        updatedAt: "2026-07-30T14:00:01.000Z",
      });
    },
  );

  it("surfaces a server rejection without falling back to the incompatible table path", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "Active church access is required" },
    });

    await expect(
      createSupabaseUploadTarget().upsert(
        "audit_log",
        auditPayload("admin"),
        "id",
        {
          organizationId,
          recordId: auditId,
          mutationToken,
        },
      ),
    ).rejects.toThrow("Active church access is required");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("keeps the append RPC authenticated, organization-scoped, and non-readable", () => {
    const migration = readFileSync(
      resolve(
        "supabase/migrations/202607300005_fix_audit_log_sync.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("if auth.uid() is null then");
    expect(migration).toContain("where id = auth.uid()");
    expect(migration).toContain("and is_active");
    expect(migration).toContain("actor.organization_id");
    expect(migration).toContain("actor.id");
    expect(migration).toContain("actor.role");
    expect(migration).toContain(
      "grant execute on function public.append_audit_log_entry(jsonb, uuid) to authenticated",
    );
    expect(migration).not.toMatch(
      /create policy[\s\S]*attendance takers read audit/i,
    );
  });
});
