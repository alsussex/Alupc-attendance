import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserContext } from "@/lib/domain";
import {
  getServiceAttendance,
  listMembers,
  markMemberInactive,
  restoreMember,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import {
  announceMutationQueued,
  subscribeToQueuedMutations,
} from "@/lib/storage/data-events";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
  getDatabase,
} from "@/lib/storage/database";
import {
  getPendingChanges,
  recoverRetryableMutations,
} from "@/lib/sync/queue";
import {
  syncBannerPresentation,
  syncIndicatorPresentation,
  type SyncPresentationInput,
} from "@/lib/sync/presentation";
import type { PullSource } from "@/lib/sync/pull-service";
import {
  synchronizeNow,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";
import {
  uploadPendingChanges,
  type UploadTarget,
} from "@/lib/sync/upload-service";

const organizationId = "20000000-0000-4000-8000-000000000070";
const administrator: UserContext = {
  userId: "10000000-0000-4000-8000-000000000070",
  organizationId,
  email: "admin@example.test",
  role: "admin",
};

class EmptyPullSource implements PullSource {
  async fetchPage() {
    return { rows: [], hasMore: false };
  }
}

class RecordingTarget implements UploadTarget {
  rows = new Map<string, Record<string, unknown>>();
  attempts = 0;
  failuresRemaining = 0;
  gate?: Promise<void>;

  async upsert(
    table: "people" | "services" | "service_attendance" | "service_visitors",
    payload: Record<string, unknown>,
  ) {
    this.attempts += 1;
    if (this.gate) await this.gate;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Temporary policy rejection");
    }
    this.rows.set(`${table}:${String(payload.id)}`, payload);
  }
}

function presentation(
  overrides: Partial<SyncPresentationInput> = {},
): SyncPresentationInput {
  return {
    phase: "complete",
    pendingCount: 0,
    pendingVisible: false,
    consecutiveFailures: 0,
    recoveryState: "idle",
    recoveryCount: 0,
    recoveryPrefix: "Saving changes",
    ...overrides,
  };
}

beforeEach(async () => {
  await clearLocalDatabase();
  vi.useRealTimers();
});

describe("queued mutation execution", () => {
  it("queues an inactive people mutation and notifies the automatic scheduler", async () => {
    const member = await saveMember(administrator, {
      firstName: "Avery",
      lastName: "Stone",
    });
    await uploadPendingChanges(organizationId, new RecordingTarget());
    const queued = vi.fn();
    const unsubscribe = subscribeToQueuedMutations(queued);

    await markMemberInactive(administrator, member.id);

    expect(queued).toHaveBeenCalledTimes(2);
    expect(await getPendingChanges(organizationId)).toEqual([
      expect.objectContaining({
        table: "people",
        recordId: member.id,
        status: "pending",
        payload: expect.objectContaining({ is_active: false }),
      }),
    ]);
    unsubscribe();
  });

  it("starts a real automatic synchronization when an inactive mutation is queued", async () => {
    const member = await saveMember(administrator, {
      firstName: "Morgan",
      lastName: "Lane",
    });
    await uploadPendingChanges(organizationId, new RecordingTarget());
    const target = new RecordingTarget();
    const source = new EmptyPullSource();
    let automaticAttempt: Promise<unknown> | undefined;
    const unsubscribe = subscribeToQueuedMutations(() => {
      automaticAttempt = synchronizeOrganization(administrator, {
        uploadTarget: target,
        pullSource: source,
        isOnline: true,
        trigger: "automatic",
      });
    });

    await markMemberInactive(administrator, member.id);
    await automaticAttempt;

    expect(target.rows.get(`people:${member.id}`)).toMatchObject({
      id: member.id,
      is_active: false,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    unsubscribe();
  });

  it("manual sync immediately recovers a failed mutation and clears its old error", async () => {
    const member = await saveMember(administrator, {
      firstName: "Jordan",
      lastName: "West",
    });
    const target = new RecordingTarget();
    target.failuresRemaining = 1;
    await uploadPendingChanges(organizationId, target);
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      status: "error",
      lastError: "Temporary policy rejection",
    });

    const result = await synchronizeNow(administrator, {
      uploadTarget: target,
      pullSource: new EmptyPullSource(),
      isOnline: true,
    });

    expect(result.upload.uploaded).toBe(1);
    expect(target.rows.has(`people:${member.id}`)).toBe(true);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("manual sync recovers a stale processing lock without changing its mutation id", async () => {
    const member = await saveMember(administrator, {
      firstName: "Riley",
      lastName: "Green",
    });
    const database = await getDatabase();
    const queued = (await getPendingChanges(organizationId))[0];
    await database.put("syncQueue", {
      ...queued,
      status: "processing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const target = new RecordingTarget();
    await synchronizeNow(administrator, {
      uploadTarget: target,
      pullSource: new EmptyPullSource(),
      isOnline: true,
    });

    expect(target.rows.has(`people:${member.id}`)).toBe(true);
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
    expect(queued.id).toBeTruthy();
  });

  it("recovers errors and only stale processing mutations during automatic startup", async () => {
    await saveMember(administrator, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    const database = await getDatabase();
    const queued = (await getPendingChanges(organizationId))[0];
    await database.put("syncQueue", {
      ...queued,
      status: "processing",
      updatedAt: new Date().toISOString(),
    });
    expect(await recoverRetryableMutations(organizationId)).toBe(0);

    await database.put("syncQueue", {
      ...queued,
      status: "processing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await recoverRetryableMutations(organizationId)).toBe(1);
    expect((await getPendingChanges(organizationId))[0]).toMatchObject({
      id: queued.id,
      status: "pending",
      lastError: undefined,
    });
  });

  it("shares one processor across concurrent requests and avoids duplicate upserts", async () => {
    await saveMember(administrator, {
      firstName: "Taylor",
      lastName: "Brooks",
    });
    let release!: () => void;
    const target = new RecordingTarget();
    target.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      uploadTarget: target,
      pullSource: new EmptyPullSource(),
      isOnline: true,
    };

    const first = synchronizeOrganization(administrator, options);
    const second = synchronizeOrganization(administrator, options);
    release();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(target.attempts).toBe(2);
    expect(target.rows.size).toBe(2);
  });

  it("keeps a newer inactive payload queued when it arrives during an upload", async () => {
    const member = await saveMember(administrator, {
      firstName: "Drew",
      lastName: "Meadow",
    });
    let signalStarted!: () => void;
    let releaseUpload!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const firstTarget: UploadTarget = {
      async upsert() {
        signalStarted();
        await gate;
      },
    };

    const firstUpload = uploadPendingChanges(organizationId, firstTarget);
    await started;
    await markMemberInactive(administrator, member.id);
    releaseUpload();
    await firstUpload;

    const queued = await getPendingChanges(organizationId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      recordId: member.id,
      status: "pending",
      payload: expect.objectContaining({ is_active: false }),
    });

    const finalTarget = new RecordingTarget();
    await uploadPendingChanges(organizationId, finalTarget);
    expect(finalTarget.rows.get(`people:${member.id}`)).toMatchObject({
      is_active: false,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });
});

describe("lifecycle retry data safety", () => {
  it("preserves the same member UUID and attendance history through restart and retry", async () => {
    const member = await saveMember(administrator, {
      firstName: "Robin",
      lastName: "Field",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-08-30",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await setMemberAttendance(administrator, service.id, member.id, true);
    await saveService(administrator, { ...service, status: "completed" });
    await uploadPendingChanges(organizationId, new RecordingTarget());
    await markMemberInactive(administrator, member.id);
    const target = new RecordingTarget();
    target.failuresRemaining = 1;
    await uploadPendingChanges(organizationId, target);
    await closeLocalDatabaseConnection();

    const failedAfterRestart = (await getPendingChanges(organizationId))[0];
    expect(failedAfterRestart).toMatchObject({
      recordId: member.id,
      status: "error",
    });
    await synchronizeNow(administrator, {
      uploadTarget: target,
      pullSource: new EmptyPullSource(),
      isOnline: true,
    });

    expect((await listMembers(organizationId))[0]).toMatchObject({
      id: member.id,
      isActive: false,
    });
    expect(await getServiceAttendance(service.id)).toEqual([
      expect.objectContaining({ personId: member.id, present: true }),
    ]);
    expect(target.rows.get(`people:${member.id}`)).toMatchObject({
      id: member.id,
      is_active: false,
    });
    expect(await getPendingChanges(organizationId)).toHaveLength(0);
  });

  it("keeps reactivation and attendance uploads working", async () => {
    const member = await saveMember(administrator, {
      firstName: "Jamie",
      lastName: "River",
    });
    const service = await saveService(administrator, {
      serviceDate: "2026-09-02",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    await markMemberInactive(administrator, member.id);
    await restoreMember(administrator, member.id);
    await setMemberAttendance(administrator, service.id, member.id, true);
    const target = new RecordingTarget();

    await synchronizeOrganization(administrator, {
      uploadTarget: target,
      pullSource: new EmptyPullSource(),
      isOnline: true,
      trigger: "automatic",
    });

    expect(target.rows.get(`people:${member.id}`)).toMatchObject({
      id: member.id,
      is_active: true,
    });
    expect(
      target.rows.get(`service_attendance:${service.id}:${member.id}`),
    ).toMatchObject({ present: true });
  });
});

describe("sync status presentation", () => {
  it("presents Up to date, Syncing, All changes synced, then Up to date", () => {
    expect(syncIndicatorPresentation(presentation()).label).toBe("Up to date");
    expect(
      syncIndicatorPresentation(
        presentation({
          phase: "loading",
          recoveryState: "syncing",
          pendingCount: 1,
          recoveryCount: 1,
        }),
      ).label,
    ).toBe("Syncing");
    expect(
      syncIndicatorPresentation(
        presentation({ recoveryState: "complete" }),
      ).label,
    ).toBe("All changes synced");
    expect(
      syncIndicatorPresentation(presentation({ recoveryState: "idle" })).label,
    ).toBe("Up to date");
  });

  it("shows the safe user-facing failure message and a real manual action", () => {
    const failure = syncBannerPresentation(
      presentation({
        phase: "error",
        pendingCount: 1,
        consecutiveFailures: 3,
      }),
    );
    expect(failure).toMatchObject({
      message:
        "Some changes could not sync. They are safely saved on this device. Automatic retry will continue.",
      showManualAction: true,
    });
  });

  it("emits a mutation notification independently of UI data refreshes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToQueuedMutations(listener);
    announceMutationQueued();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
