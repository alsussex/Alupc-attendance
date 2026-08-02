import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { shouldRevalidateAccess } from "@/components/auth/AuthProvider";
import {
  BACKGROUND_PULL_TABLES,
  OPERATIONAL_PULL_TABLES,
  type PullTable,
  type SyncCursor,
  type SyncQueueItem,
  type UserContext,
} from "@/lib/domain";
import {
  getNetworkTelemetrySummary,
  resetNetworkTelemetry,
  telemetryFetch,
} from "@/lib/network/telemetry";
import { saveMember } from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import {
  pullOrganizationData,
  type PullSource,
} from "@/lib/sync/pull-service";
import {
  evaluateStartupCursors,
  STARTUP_CURSOR_MAX_AGE_MS,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";
import type { UploadTarget } from "@/lib/sync/upload-service";

const organizationId = "20000000-0000-4000-8000-000000000088";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000088",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

class CountingPullSource implements PullSource {
  calls: PullTable[] = [];

  async fetchPage(table: PullTable) {
    this.calls.push(table);
    return { rows: [], hasMore: false };
  }
}

class RecordingUploadTarget implements UploadTarget {
  calls: string[] = [];

  constructor(private readonly gate?: Promise<void>) {}

  async upsert(
    table: SyncQueueItem["table"],
    payload: Record<string, unknown>,
  ) {
    await this.gate;
    this.calls.push(`${table}:${String(payload.id)}`);
    return { version: 2, updatedAt: "2026-08-02T12:00:00.000Z" };
  }
}

beforeEach(async () => {
  await clearLocalDatabase();
});

describe("low-egress bidirectional synchronization", () => {
  it("uploads queued local changes without querying every remote table", async () => {
    await saveMember(user, { firstName: "Avery", lastName: "River" });
    const source = new CountingPullSource();
    const target = new RecordingUploadTarget();

    const result = await synchronizeOrganization(user, {
      isOnline: true,
      pullSource: source,
      uploadTarget: target,
      trigger: "automatic",
      skipPull: true,
    });

    expect(result.upload.uploaded).toBeGreaterThan(0);
    expect(source.calls).toEqual([]);
  });

  it("does not lose a targeted remote pull that arrives during an upload", async () => {
    await saveMember(user, { firstName: "Morgan", lastName: "Vale" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const source = new CountingPullSource();
    const target = new RecordingUploadTarget(gate);

    const upload = synchronizeOrganization(user, {
      isOnline: true,
      pullSource: source,
      uploadTarget: target,
      trigger: "automatic",
      skipPull: true,
    });
    const remoteDelta = synchronizeOrganization(user, {
      isOnline: true,
      pullSource: source,
      uploadTarget: target,
      trigger: "remote",
      pullTables: ["people"],
    });
    release?.();

    await Promise.all([upload, remoteDelta]);
    expect(source.calls).toEqual(["people"]);
  });

  it("uses explicit columns and a strict composite cloud cursor", () => {
    const source = readFileSync(resolve("lib/sync/pull-service.ts"), "utf8");

    expect(source).toContain(".select(PULL_COLUMNS[table])");
    expect(source).not.toContain('.select("*")');
    expect(source).toContain("updated_at.gt.${updatedAt}");
    expect(source).toContain("id.gt.${recordId}");
  });

  it("keeps audit history out of routine background pulls", async () => {
    const source = new CountingPullSource();
    await pullOrganizationData(user, source);

    expect(source.calls).toEqual(BACKGROUND_PULL_TABLES);
    expect(source.calls).not.toContain("audit_log");
    expect(OPERATIONAL_PULL_TABLES).toEqual([
      "people",
      "services",
      "service_attendance",
      "service_visitors",
    ]);
  });

  it("keeps an empty delta probe silent and reports actual remote rows", async () => {
    let detections = 0;
    await pullOrganizationData(user, new CountingPullSource(), {
      tables: ["people"],
      onRemoteChangesDetected: () => {
        detections += 1;
      },
    });
    expect(detections).toBe(0);

    const changedSource: PullSource = {
      async fetchPage() {
        return {
          rows: [
            {
              id: "30000000-0000-4000-8000-000000000088",
              organization_id: organizationId,
              first_name: "Avery",
              last_name: "River",
              display_name: "Avery River",
              person_type: "member",
              is_active: true,
              version: 1,
              created_by: user.userId,
              updated_by: user.userId,
              created_at: "2026-08-02T10:00:00.000Z",
              updated_at: "2026-08-02T10:00:00.000Z",
            },
          ],
          hasMore: false,
        };
      },
    };
    await pullOrganizationData(user, changedSource, {
      tables: ["people"],
      onRemoteChangesDetected: () => {
        detections += 1;
      },
    });
    expect(detections).toBe(1);
  });

  it("requires visible startup work only for missing or expired cursors", () => {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const cursors = BACKGROUND_PULL_TABLES.map(
      (table): SyncCursor => ({
        id: `${user.userId}:${organizationId}:${table}`,
        userId: user.userId,
        organizationId,
        table,
        updatedAt: "2026-08-02T10:00:00.000Z",
        lastSuccessfulPullAt: "2026-08-02T11:55:00.000Z",
      }),
    );

    expect(evaluateStartupCursors(cursors, user, now)).toEqual({
      required: false,
      reason: "current",
    });
    expect(evaluateStartupCursors(cursors.slice(1), user, now).reason).toBe(
      "integrity",
    );
    expect(
      evaluateStartupCursors(
        cursors.map((cursor) => ({
          ...cursor,
          lastSuccessfulPullAt: new Date(
            now - STARTUP_CURSOR_MAX_AGE_MS - 1,
          ).toISOString(),
        })),
        user,
        now,
      ).reason,
    ).toBe("expired_cursor");
  });

  it("keeps zero-work startup probes out of the visible syncing state", () => {
    const source = readFileSync(resolve("components/sync/SyncProvider.tsx"), "utf8");
    expect(source).toContain('trigger === "startup"');
    expect(source).toContain("const silentProbe =");
    expect(source).toContain("onRemoteChangesDetected: revealProgress");
    expect(source).toContain("inspectStartupSynchronization(user)");
  });

  it("loads audit history only when explicitly targeted", async () => {
    const source = new CountingPullSource();
    await pullOrganizationData(user, source, { tables: ["audit_log"] });
    expect(source.calls).toEqual(["audit_log"]);
  });

  it("records request counts and payload sizes without retaining query values", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-length": "11" },
      });
    resetNetworkTelemetry();
    try {
      await telemetryFetch(
        "https://example.supabase.co/rest/v1/services?organization_id=secret",
        { method: "POST", body: "{}" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(getNetworkTelemetrySummary()).toEqual({
      requests: 1,
      requestBytes: 2,
      responseBytes: 11,
      byEndpoint: {
        "/rest/v1/services": { requests: 1, responseBytes: 11 },
      },
    });
  });

  it("throttles routine focus access reads but never blocks reconnect recovery", () => {
    const now = 1_000_000;

    expect(shouldRevalidateAccess(now, false, now + 60_000)).toBe(false);
    expect(shouldRevalidateAccess(now, false, now + 5 * 60_000)).toBe(true);
    expect(shouldRevalidateAccess(now, true, now + 1)).toBe(true);
  });

  it("deduplicates repeated initial-session events for an already loaded token", () => {
    const source = readFileSync(resolve("components/auth/AuthProvider.tsx"), "utf8");
    expect(source).toContain("lastLoadedAccessToken");
    expect(source).toContain(
      'nextSession?.access_token === lastLoadedAccessToken.current',
    );
  });
});
