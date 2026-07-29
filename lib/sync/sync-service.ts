"use client";

import type { SyncPhase, SyncStatusRecord, UserContext } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { hasSupabaseConfig } from "@/lib/supabase/client";
import {
  pullOrganizationData,
  type PullResult,
  type PullSource,
} from "@/lib/sync/pull-service";
import {
  uploadPendingChanges,
  type SyncTrigger,
  type UploadResult,
  type UploadTarget,
} from "@/lib/sync/upload-service";
import {
  getQueueCount,
  recoverRetryableMutations,
} from "@/lib/sync/queue";

export interface SynchronizationResult {
  upload: UploadResult;
  pull: PullResult;
}

export interface SynchronizationOptions {
  pullSource?: PullSource;
  uploadTarget?: UploadTarget;
  isOnline?: boolean;
  onPhase?: (phase: SyncPhase) => void;
  trigger?: SyncTrigger;
  forceRetry?: boolean;
}

const activeSyncs = new Map<string, Promise<SynchronizationResult>>();

export function syncRetryDelay(failedAttempts: number) {
  return Math.min(2_000 * 2 ** Math.max(0, failedAttempts), 60_000);
}

async function storeStatus(
  organizationId: string,
  phase: SyncPhase,
  error?: string,
) {
  const database = await getDatabase();
  const previous = await database.get("syncStatus", organizationId);
  const timestamp = new Date().toISOString();
  const status: SyncStatusRecord = {
    id: organizationId,
    organizationId,
    phase,
    lastAttemptAt: timestamp,
    lastSuccessfulSyncAt:
      phase === "complete" ? timestamp : previous?.lastSuccessfulSyncAt,
    lastError: error,
  };
  await database.put("syncStatus", status);
}

export async function getStoredSyncStatus(organizationId: string) {
  return (await getDatabase()).get("syncStatus", organizationId);
}

async function runSynchronization(
  user: UserContext,
  options: SynchronizationOptions,
): Promise<SynchronizationResult> {
  const online =
    options.isOnline ??
    (typeof navigator !== "undefined" && navigator.onLine);
  const injectedSynchronization = Boolean(
    options.pullSource && options.uploadTarget,
  );
  if (!online || (!hasSupabaseConfig() && !injectedSynchronization)) {
    options.onPhase?.("offline");
    await storeStatus(user.organizationId, "offline");
    return {
      upload: { uploaded: 0, errors: [] },
      pull: { downloaded: 0, merged: 0, skippedPending: 0, skippedOlder: 0 },
    };
  }

  options.onPhase?.("loading");
  await storeStatus(user.organizationId, "loading");
  await recoverRetryableMutations(user.organizationId, {
    forceProcessing: options.forceRetry,
  });
  const upload = await uploadPendingChanges(
    user.organizationId,
    options.uploadTarget,
    { trigger: options.trigger },
  );

  options.onPhase?.("downloading");
  await storeStatus(user.organizationId, "downloading");
  try {
    const pull = await pullOrganizationData(
      user.organizationId,
      options.pullSource,
    );
    if (upload.errors.length) {
      const message = upload.errors.join("\n");
      options.onPhase?.("error");
      await storeStatus(user.organizationId, "error", message);
      return { upload, pull };
    }
    options.onPhase?.("complete");
    await storeStatus(user.organizationId, "complete");
    return { upload, pull };
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "Download synchronization failed.";
    options.onPhase?.("error");
    await storeStatus(user.organizationId, "error", message);
    throw caught;
  }
}

export function synchronizeOrganization(
  user: UserContext,
  options: SynchronizationOptions = {},
) {
  const existing = activeSyncs.get(user.organizationId);
  if (existing) return existing;
  const sync = runSynchronization(user, options).finally(() => {
    activeSyncs.delete(user.organizationId);
  });
  activeSyncs.set(user.organizationId, sync);
  return sync;
}

export async function synchronizeNow(
  user: UserContext,
  options: Omit<
    SynchronizationOptions,
    "trigger" | "forceRetry"
  > = {},
) {
  let result = await synchronizeOrganization(user, {
    ...options,
    trigger: "manual",
    forceRetry: true,
  });
  if (await getQueueCount(user.organizationId)) {
    result = await synchronizeOrganization(user, {
      ...options,
      trigger: "manual",
      forceRetry: true,
    });
  }
  return result;
}

export function registerAutomaticSync(
  user: UserContext,
  synchronize: (trigger?: SyncTrigger) => Promise<unknown>,
  options: { listenOnline?: boolean } = {},
) {
  const online = () => void synchronize("online");
  const focus = () => void synchronize("focus");
  if (options.listenOnline !== false) {
    window.addEventListener("online", online);
  }
  window.addEventListener("focus", focus);
  const interval = window.setInterval(
    () => void synchronize("scheduled"),
    60_000,
  );
  return () => {
    if (options.listenOnline !== false) {
      window.removeEventListener("online", online);
    }
    window.removeEventListener("focus", focus);
    window.clearInterval(interval);
  };
}
