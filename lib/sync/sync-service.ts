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
  fullSnapshot?: boolean;
  recoverAccess?: () => Promise<UserContext | null>;
}

const activeSyncs = new Map<string, Promise<SynchronizationResult>>();

export function syncRetryDelay(failedAttempts: number) {
  return Math.min(2_000 * 2 ** Math.max(0, failedAttempts), 60_000);
}

async function storeStatus(
  user: UserContext,
  phase: SyncPhase,
  error?: string,
) {
  const database = await getDatabase();
  const id = `${user.userId}:${user.organizationId}`;
  const previous = await database.get("syncStatus", id);
  const timestamp = new Date().toISOString();
  const status: SyncStatusRecord = {
    id,
    userId: user.userId,
    organizationId: user.organizationId,
    phase,
    lastAttemptAt: timestamp,
    lastSuccessfulSyncAt:
      phase === "complete" ? timestamp : previous?.lastSuccessfulSyncAt,
    lastError: error,
  };
  await database.put("syncStatus", status);
}

export async function getStoredSyncStatus(
  organizationId: string,
  userId?: string,
) {
  const database = await getDatabase();
  if (userId) {
    return database.get("syncStatus", `${userId}:${organizationId}`);
  }
  const records = await database.getAllFromIndex(
    "syncStatus",
    "organizationId",
    organizationId,
  );
  return records.sort((left, right) =>
    right.lastAttemptAt.localeCompare(left.lastAttemptAt),
  )[0];
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
    await storeStatus(user, "offline");
    return {
      upload: { uploaded: 0, errors: [] },
      pull: { downloaded: 0, merged: 0, skippedPending: 0, skippedOlder: 0 },
    };
  }

  options.onPhase?.("loading");
  await storeStatus(user, "loading");
  await recoverRetryableMutations(user.organizationId, {
    forceProcessing: options.forceRetry,
  });
  const upload = await uploadPendingChanges(
    user.organizationId,
    options.uploadTarget,
    { trigger: options.trigger },
  );

  options.onPhase?.("downloading");
  await storeStatus(user, "downloading");
  try {
    const pull = await pullOrganizationData(
      user,
      options.pullSource,
      { fullSnapshot: options.fullSnapshot },
    );
    if (upload.errors.length) {
      const message = upload.errors.join("\n");
      options.onPhase?.("error");
      await storeStatus(user, "error", message);
      return { upload, pull };
    }
    options.onPhase?.("complete");
    await storeStatus(user, "complete");
    return { upload, pull };
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "Download synchronization failed.";
    options.onPhase?.("error");
    await storeStatus(user, "error", message);
    throw caught;
  }
}

export function synchronizeOrganization(
  user: UserContext,
  options: SynchronizationOptions = {},
) {
  const syncKey = `${user.userId}:${user.organizationId}`;
  const existing = activeSyncs.get(syncKey);
  if (existing) return existing;
  const sync = runSynchronization(user, options).finally(() => {
    activeSyncs.delete(syncKey);
  });
  activeSyncs.set(syncKey, sync);
  return sync;
}

export function isAuthenticationSynchronizationError(value: unknown) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  return /(?:jwt|token|session|not authenticated|authentication|permission denied|row-level security|pgrst301|42501|401|403)/i.test(
    message,
  );
}

export async function synchronizeWithSessionRecovery(
  user: UserContext,
  options: SynchronizationOptions = {},
) {
  try {
    const result = await synchronizeOrganization(user, options);
    if (
      !options.recoverAccess ||
      !result.upload.errors.some(isAuthenticationSynchronizationError)
    ) {
      return result;
    }
    const recovered = await options.recoverAccess();
    if (
      !recovered ||
      recovered.userId !== user.userId ||
      recovered.organizationId !== user.organizationId
    ) {
      return result;
    }
    return synchronizeOrganization(recovered, {
      ...options,
      recoverAccess: undefined,
      forceRetry: true,
    });
  } catch (caught) {
    if (
      !options.recoverAccess ||
      !isAuthenticationSynchronizationError(caught)
    ) {
      throw caught;
    }
    const recovered = await options.recoverAccess();
    if (
      !recovered ||
      recovered.userId !== user.userId ||
      recovered.organizationId !== user.organizationId
    ) {
      throw caught;
    }
    return synchronizeOrganization(recovered, {
      ...options,
      recoverAccess: undefined,
      forceRetry: true,
    });
  }
}

export async function synchronizeNow(
  user: UserContext,
  options: Omit<
    SynchronizationOptions,
    "trigger" | "forceRetry"
  > = {},
) {
  let result = await synchronizeWithSessionRecovery(user, {
    ...options,
    trigger: "manual",
    forceRetry: true,
  });
  if (await getQueueCount(user.organizationId)) {
    result = await synchronizeWithSessionRecovery(user, {
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
    30_000,
  );
  return () => {
    if (options.listenOnline !== false) {
      window.removeEventListener("online", online);
    }
    window.removeEventListener("focus", focus);
    window.clearInterval(interval);
  };
}
