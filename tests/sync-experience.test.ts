import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncPhase, UserContext } from "@/lib/domain";
import {
  addServiceVisitor,
  getServiceAttendance,
  listServices,
  saveMember,
  saveService,
  setMemberAttendance,
} from "@/lib/repositories/attendance-repository";
import { serviceSaveFeedback } from "@/lib/services/save-feedback";
import {
  clearLocalDatabase,
  closeLocalDatabaseConnection,
} from "@/lib/storage/database";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  syncBannerPresentation,
  syncIndicatorPresentation,
  type SyncPresentationInput,
} from "@/lib/sync/presentation";
import { registerAutomaticSync } from "@/lib/sync/sync-service";

const organizationId = "20000000-0000-4000-8000-000000000040";
const user: UserContext = {
  userId: "10000000-0000-4000-8000-000000000040",
  organizationId,
  email: "taker@example.test",
  role: "attendance_taker",
};

function presentation(
  overrides: Partial<SyncPresentationInput> = {},
): SyncPresentationInput {
  return {
    phase: "complete" as SyncPhase,
    pendingCount: 0,
    pendingVisible: false,
    consecutiveFailures: 0,
    recoveryState: "idle",
    recoveryCount: 0,
    recoveryPrefix: "Back online",
    ...overrides,
  };
}

beforeEach(async () => {
  await clearLocalDatabase();
  vi.useRealTimers();
});

describe("quiet routine synchronization", () => {
  it("preserves rapid attendance changes in order and queues only the final state", async () => {
    const member = await saveMember(user, {
      firstName: "Avery",
      lastName: "Stone",
    });
    const service = await saveService(user, {
      serviceDate: "2026-07-29",
      serviceType: "Wednesday Bible Study",
      status: "draft",
    });
    await Promise.all([
      setMemberAttendance(user, service.id, member.id, true),
      setMemberAttendance(user, service.id, member.id, false),
      setMemberAttendance(user, service.id, member.id, true),
    ]);

    const attendance = await getServiceAttendance(service.id);
    const queuedAttendance = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "service_attendance",
    );
    expect(attendance).toHaveLength(1);
    expect(attendance[0].present).toBe(true);
    expect(queuedAttendance).toHaveLength(1);
    expect(queuedAttendance[0].payload.present).toBe(true);
  });

  it("queues people and visitors without showing a routine sync banner", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-02",
      serviceType: "Sunday Morning",
      status: "draft",
    });
    await saveMember(user, { firstName: "Morgan", lastName: "Lane" });
    await addServiceVisitor(user, service.id, {
      firstName: "Jordan",
      lastName: "West",
      saveAsMember: false,
    });

    const queue = await getPendingChanges(organizationId);
    expect(queue.some((item) => item.table === "people")).toBe(true);
    expect(queue.some((item) => item.table === "service_visitors")).toBe(true);
    expect(
      syncBannerPresentation(
        presentation({ phase: "pending", pendingCount: queue.length }),
      ),
    ).toBeNull();
  });

  it("retains unsynchronized records and mutations after the local database reopens", async () => {
    const member = await saveMember(user, {
      firstName: "Casey",
      lastName: "Harbor",
    });
    await closeLocalDatabaseConnection();

    const queued = await getPendingChanges(organizationId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      table: "people",
      recordId: member.id,
      status: "pending",
    });
  });

  it("persists draft and completed service states locally before synchronization", async () => {
    const service = await saveService(user, {
      serviceDate: "2026-08-09",
      serviceType: "Sunday Evening",
      status: "draft",
    });
    expect((await listServices(organizationId))[0].status).toBe("draft");

    await saveService(user, { ...service, status: "completed" });
    const stored = (await listServices(organizationId))[0];
    const queued = (await getPendingChanges(organizationId)).filter(
      (item) => item.table === "services",
    );
    expect(stored.status).toBe("completed");
    expect(queued).toHaveLength(1);
    expect(queued[0].payload.status).toBe("completed");
  });

  it("does not include routine success or progress copy in member and service flows", () => {
    const peopleSource = readFileSync(
      resolve("components/people/PeopleDirectory.tsx"),
      "utf8",
    );
    const serviceSource = readFileSync(
      resolve("components/services/ServiceManager.tsx"),
      "utf8",
    );

    expect(peopleSource).toContain("Member added.");
    expect(peopleSource).not.toContain("Reactivating…");
    expect(peopleSource).not.toContain('"Saving…"');
    expect(serviceSource).not.toContain("added to this service.");
    expect(serviceSource).not.toContain("Service details updated.");
    expect(serviceSource).toMatch(
      /serviceAction === "draft" \? "Saving…" : "Save Draft"/,
    );
    expect(serviceSource).toMatch(
      /serviceAction === "completed" \? "Saving…" : "Finish Service"/,
    );
  });
});

describe("explicit service save feedback", () => {
  it("provides the requested draft messages", () => {
    expect(serviceSaveFeedback("draft", "synced")).toBe("Saved as draft.");
    expect(serviceSaveFeedback("draft", "offline")).toBe(
      "Saved as draft on this device — will sync automatically.",
    );
  });

  it("provides the requested completed messages", () => {
    expect(serviceSaveFeedback("completed", "synced")).toBe(
      "Service completed.",
    );
    expect(serviceSaveFeedback("completed", "offline")).toBe(
      "Completed on this device — will sync automatically.",
    );
  });
});

describe("offline and retry visibility", () => {
  it("shows pending counts offline and recovery confirmation after reconnecting", () => {
    expect(
      syncBannerPresentation(
        presentation({ phase: "local", pendingCount: 6 }),
      )?.message,
    ).toBe(
      "Offline — 6 changes saved on this device and waiting to sync.",
    );
    expect(
      syncBannerPresentation(
        presentation({
          recoveryState: "syncing",
          recoveryCount: 6,
        }),
      )?.message,
    ).toBe("Back online — syncing 6 changes…");
    expect(
      syncBannerPresentation(
        presentation({ recoveryState: "complete" }),
      )?.message,
    ).toBe("All changes synced.");
  });

  it("keeps normal online work quiet and exposes errors only after repeated failures", () => {
    expect(syncIndicatorPresentation(presentation()).label).toBe("Online");
    expect(
      syncBannerPresentation(
        presentation({ consecutiveFailures: 2, pendingCount: 3 }),
      ),
    ).toBeNull();
    const repeatedFailure = syncBannerPresentation(
      presentation({ consecutiveFailures: 3, pendingCount: 3 }),
    );
    expect(repeatedFailure?.showManualAction).toBe(true);
    expect(repeatedFailure?.message).toContain("Automatic retry will continue");
  });

  it("automatically triggers on reconnect, focus, and a low-egress ten-minute fallback", async () => {
    vi.useFakeTimers();
    const synchronize = vi.fn(async () => undefined);
    const stop = registerAutomaticSync(user, synchronize);

    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(synchronize).toHaveBeenCalledTimes(4);
    expect(synchronize).toHaveBeenNthCalledWith(1, "online");
    expect(synchronize).toHaveBeenNthCalledWith(2, "focus");
    expect(synchronize).toHaveBeenNthCalledWith(3, "focus");
    expect(synchronize).toHaveBeenNthCalledWith(4, "scheduled");
    stop();
  });
});
