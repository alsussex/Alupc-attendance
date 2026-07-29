import type { SyncPhase } from "@/lib/domain";

export type RecoveryState = "idle" | "syncing" | "complete";

export interface SyncPresentationInput {
  phase: SyncPhase;
  pendingCount: number;
  pendingVisible: boolean;
  consecutiveFailures: number;
  recoveryState: RecoveryState;
  recoveryCount: number;
  recoveryPrefix: "Back online" | "Restoring saved changes";
}

export function isOfflinePhase(phase: SyncPhase) {
  return phase === "offline" || phase === "local";
}

export function syncIndicatorPresentation(input: SyncPresentationInput) {
  if (isOfflinePhase(input.phase)) {
    return { label: "Offline", tone: "offline" };
  }
  if (input.consecutiveFailures >= 3) {
    return { label: "Sync issue", tone: "error" };
  }
  if (input.pendingVisible && input.pendingCount > 0) {
    return {
      label: `${input.pendingCount} pending`,
      tone: "pending",
    };
  }
  return { label: "Online", tone: "online" };
}

export function syncBannerPresentation(input: SyncPresentationInput) {
  if (isOfflinePhase(input.phase)) {
    return {
      tone: "offline",
      message:
        input.pendingCount > 0
          ? `Offline — ${input.pendingCount} ${input.pendingCount === 1 ? "change" : "changes"} saved on this device and waiting to sync.`
          : "Offline — changes will be saved on this device.",
      showManualAction: false,
    };
  }
  if (input.consecutiveFailures >= 3) {
    return {
      tone: "error",
      message:
        input.pendingCount > 0
          ? `Sync needs attention — ${input.pendingCount} ${input.pendingCount === 1 ? "change remains" : "changes remain"} safely saved on this device. Automatic retry will continue.`
          : "Sync needs attention. Automatic retry will continue.",
      showManualAction: true,
    };
  }
  if (input.recoveryState === "syncing") {
    const count = Math.max(input.recoveryCount, input.pendingCount);
    return {
      tone: "recovering",
      message: `${input.recoveryPrefix} — syncing ${count} ${count === 1 ? "change" : "changes"}…`,
      showManualAction: false,
    };
  }
  if (input.recoveryState === "complete") {
    return {
      tone: "complete",
      message: "All changes synced.",
      showManualAction: false,
    };
  }
  return null;
}
