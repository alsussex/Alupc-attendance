import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { shouldRevalidateAccess } from "@/components/auth/AuthProvider";
import type { PullTable, SyncQueueItem, UserContext } from "@/lib/domain";
import { saveMember } from "@/lib/repositories/attendance-repository";
import { clearLocalDatabase } from "@/lib/storage/database";
import type { PullSource } from "@/lib/sync/pull-service";
import { synchronizeOrganization } from "@/lib/sync/sync-service";
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

  it("throttles routine focus access reads but never blocks reconnect recovery", () => {
    const now = 1_000_000;

    expect(shouldRevalidateAccess(now, false, now + 60_000)).toBe(false);
    expect(shouldRevalidateAccess(now, false, now + 5 * 60_000)).toBe(true);
    expect(shouldRevalidateAccess(now, true, now + 1)).toBe(true);
  });
});
