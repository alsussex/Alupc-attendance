"use client";

import type {
  SyncCursor,
  PullTable,
  SyncPhase,
  SyncStatusRecord,
  UserContext,
} from "@/lib/domain";
import { BACKGROUND_PULL_TABLES, PULL_TABLES } from "@/lib/domain";
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
  pullTables?: readonly PullTable[];
  skipPull?: boolean;
  onRemoteChangesDetected?: () => void;
  recoverAccess?: () => Promise<UserContext | null>;
}

interface ActiveSynchronization {
  promise: Promise<SynchronizationResult>;
  options: SynchronizationOptions;
}

const activeSyncs = new Map<string, ActiveSynchronization>();

const emptyPullResult = (): PullResult => ({
  downloaded: 0,
  merged: 0,
  skippedPending: 0,
  skippedOlder: 0,
});

function activePullCovers(
  active: SynchronizationOptions,
  requested: SynchronizationOptions,
) {
  if (requested.skipPull) return true;
  if (active.skipPull) return false;
  if (!active.pullTables) return true;
  if (!requested.pullTables) return false;
  return requested.pullTables.every((table) =>
    active.pullTables?.includes(table),
  );
}

export function syncRetryDelay(failedAttempts: number) {
  return Math.min(2_000 * 2 ** Math.max(0, failedAttempts), 60_000);
}

export const STARTUP_CURSOR_MAX_AGE_MS = 24 * 60 * 60_000;

export function evaluateStartupCursors(
  cursors: SyncCursor[],
  user: UserContext,
  now = Date.now(),
) {
  const scoped = new Map(
    cursors
      .filter(
        (cursor) =>
          cursor.userId === user.userId &&
          cursor.organizationId === user.organizationId,
      )
      .map((cursor) => [cursor.table, cursor]),
  );
  if (BACKGROUND_PULL_TABLES.some((table) => !scoped.has(table))) {
    return { required: true, reason: "integrity" as const };
  }
  if (
    BACKGROUND_PULL_TABLES.some((table) => {
      const pulledAt = Date.parse(scoped.get(table)?.lastSuccessfulPullAt ?? "");
      return !Number.isFinite(pulledAt) || now - pulledAt > STARTUP_CURSOR_MAX_AGE_MS;
    })
  ) {
    return { required: true, reason: "expired_cursor" as const };
  }
  return { required: false, reason: "current" as const };
}

export async function inspectStartupSynchronization(user: UserContext) {
  const database = await getDatabase();
  const cursors = await database.getAllFromIndex(
    "syncCursors",
    "organizationId",
    user.organizationId,
  );
  return evaluateStartupCursors(cursors, user);
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
      upload: {
        uploaded: 0,
        errors: [],
        diagnostics: [],
        blockedConflicts: 0,
      },
      pull: emptyPullResult(),
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

  try {
    let pull = emptyPullResult();
    if (!options.skipPull) {
      options.onPhase?.("downloading");
      await storeStatus(user, "downloading");
      pull = await pullOrganizationData(user, options.pullSource, {
        fullSnapshot: options.fullSnapshot,
        tables: options.pullTables,
        onRemoteChangesDetected: options.onRemoteChangesDetected,
      });
    }
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
): Promise<SynchronizationResult> {
  const syncKey = `${user.userId}:${user.organizationId}`;
  const existing = activeSyncs.get(syncKey);
  if (existing) {
    if (
      !options.forceRetry &&
      activePullCovers(existing.options, options)
    ) {
      return existing.promise;
    }
    // A targeted Realtime pull or a manual request that arrives during an
    // upload-only pass must not be lost. Run it immediately afterward while
    // still keeping one processor active at a time.
    return existing.promise.then(() => synchronizeOrganization(user, options));
  }
  const sync = runSynchronization(user, options).finally(() => {
    if (activeSyncs.get(syncKey)?.promise === sync) {
      activeSyncs.delete(syncKey);
    }
  });
  activeSyncs.set(syncKey, { promise: sync, options });
  return sync;
}

export function isAuthenticationSynchronizationError(value: unknown) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  return /(?:jwt.*(?:expired|invalid)|token.*(?:expired|invalid|missing)|session.*(?:expired|invalid|missing)|not authenticated|authentication required|pgrst301|\b401\b)/i.test(
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
      !(result.upload.diagnostics ?? result.upload.errors).some(
        isAuthenticationSynchronizationError,
      )
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
  const pullTables = options.pullTables ?? PULL_TABLES;
  let result = await synchronizeWithSessionRecovery(user, {
    ...options,
    pullTables,
    trigger: "manual",
    forceRetry: true,
  });
  if (await getQueueCount(user.organizationId)) {
    result = await synchronizeWithSessionRecovery(user, {
      ...options,
      pullTables,
      trigger: "manual",
      forceRetry: true,
      // The first pass already performed the bidirectional delta pull. This
      // second pass only drains a mutation that became retryable after that
      // reconciliation, avoiding a duplicate download of every table.
      skipPull: true,
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
  const visible = () => {
    if (document.visibilityState === "visible") void synchronize("focus");
  };
  if (options.listenOnline !== false) {
    window.addEventListener("online", online);
  }
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visible);
  const interval = window.setInterval(
    () => void synchronize("scheduled"),
    10 * 60_000,
  );
  return () => {
    if (options.listenOnline !== false) {
      window.removeEventListener("online", online);
    }
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", visible);
    window.clearInterval(interval);
  };
}
