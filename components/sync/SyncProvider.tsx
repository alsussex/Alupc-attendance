"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { SyncPhase } from "@/lib/domain";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { getQueueCount } from "@/lib/sync/queue";
import type { RecoveryState } from "@/lib/sync/presentation";
import {
  registerAutomaticSync,
  syncRetryDelay,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";

export interface SyncAttemptOutcome {
  status: "synced" | "pending" | "offline" | "error";
  pendingCount: number;
}

interface SyncContextValue {
  phase: SyncPhase;
  error: string | null;
  pendingCount: number;
  pendingVisible: boolean;
  consecutiveFailures: number;
  recoveryState: RecoveryState;
  recoveryCount: number;
  recoveryPrefix: "Back online" | "Restoring saved changes";
  syncNow: () => Promise<SyncAttemptOutcome>;
}

const SyncContext = createContext<SyncContextValue | null>(null);
const MUTATION_DEBOUNCE_MS = 450;
const PENDING_VISIBILITY_DELAY_MS = 2_000;
const RECOVERY_CONFIRMATION_MS = 2_500;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<SyncPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingVisible, setPendingVisible] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [recoveryState, setRecoveryState] =
    useState<RecoveryState>("idle");
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [recoveryPrefix, setRecoveryPrefix] = useState<
    "Back online" | "Restoring saved changes"
  >("Back online");

  const attemptSynchronization = useCallback(
    async (drainQueue = false): Promise<SyncAttemptOutcome> => {
      if (!user) return { status: "error", pendingCount: 0 };
      let count = await getQueueCount(user.organizationId);
      setPendingCount(count);
      if (!navigator.onLine) {
        setPhase(count > 0 ? "local" : "offline");
        setPendingVisible(false);
        return { status: "offline", pendingCount: count };
      }

      try {
        const cycles = drainQueue ? 2 : 1;
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const result = await synchronizeOrganization(user, {
            onPhase: setPhase,
          });
          count = await getQueueCount(user.organizationId);
          setPendingCount(count);
          if (result.upload.errors.length) {
            const message = result.upload.errors.join("\n");
            setError(message);
            setPhase("error");
            setConsecutiveFailures((current) => current + 1);
            return { status: "error", pendingCount: count };
          }
          if (count === 0) break;
        }

        if (count > 0) {
          setPhase("pending");
          return { status: "pending", pendingCount: count };
        }
        setError(null);
        setConsecutiveFailures(0);
        setPendingVisible(false);
        setPhase("complete");
        return { status: "synced", pendingCount: 0 };
      } catch (caught) {
        count = await getQueueCount(user.organizationId);
        setPendingCount(count);
        if (!navigator.onLine) {
          setPhase(count > 0 ? "local" : "offline");
          setPendingVisible(false);
          return { status: "offline", pendingCount: count };
        }
        setError(
          caught instanceof Error ? caught.message : "Synchronization failed.",
        );
        setPhase("error");
        setConsecutiveFailures((current) => current + 1);
        return { status: "error", pendingCount: count };
      }
    },
    [user],
  );

  const syncNow = useCallback(
    () => attemptSynchronization(true),
    [attemptSynchronization],
  );

  useEffect(() => {
    if (!user) return;
    let retryTimer: number | undefined;
    let mutationTimer: number | undefined;
    let pendingVisibilityTimer: number | undefined;
    let recoveryTimer: number | undefined;
    let failedAttempts = 0;
    let stopped = false;
    let recovering = false;

    const clearTimer = (timer: number | undefined) => {
      if (timer) window.clearTimeout(timer);
    };

    const finishRecovery = () => {
      if (!recovering) return;
      recovering = false;
      setRecoveryState("complete");
      clearTimer(recoveryTimer);
      recoveryTimer = window.setTimeout(
        () => setRecoveryState("idle"),
        RECOVERY_CONFIRMATION_MS,
      );
    };

    const scheduleRetry = (callback: () => void) => {
      clearTimer(retryTimer);
      retryTimer = window.setTimeout(
        callback,
        syncRetryDelay(failedAttempts),
      );
      failedAttempts += 1;
    };

    const runAutomaticSync = async () => {
      if (stopped || !navigator.onLine) return;
      const outcome = await attemptSynchronization();
      if (stopped) return;
      if (outcome.status === "synced") {
        failedAttempts = 0;
        clearTimer(retryTimer);
        clearTimer(pendingVisibilityTimer);
        setPendingVisible(false);
        finishRecovery();
        return;
      }
      if (outcome.status === "pending") {
        clearTimer(mutationTimer);
        mutationTimer = window.setTimeout(
          () => void runAutomaticSync(),
          MUTATION_DEBOUNCE_MS,
        );
        return;
      }
      if (outcome.status === "error") {
        scheduleRetry(() => void runAutomaticSync());
      }
    };

    const startRecovery = async (
      prefix: "Back online" | "Restoring saved changes",
    ) => {
      const count = await getQueueCount(user.organizationId);
      setPendingCount(count);
      if (count > 0) {
        recovering = true;
        setPhase("pending");
        setRecoveryPrefix(prefix);
        setRecoveryCount(count);
        setRecoveryState("syncing");
      }
      await runAutomaticSync();
    };

    const initialize = async () => {
      const count = await getQueueCount(user.organizationId);
      setPendingCount(count);
      if (!navigator.onLine) {
        setPhase(count > 0 ? "local" : "offline");
        return;
      }
      if (count > 0) {
        await startRecovery("Restoring saved changes");
      } else {
        await runAutomaticSync();
      }
    };

    const initial = window.setTimeout(() => void initialize(), 0);
    const stopAutomaticSync = registerAutomaticSync(
      user,
      runAutomaticSync,
      { listenOnline: false },
    );
    const stopDataListener = subscribeToDataChanges(() => {
      void getQueueCount(user.organizationId).then((count) => {
        setPendingCount(count);
        if (count === 0) return;
        if (!navigator.onLine) {
          setPhase("local");
          setPendingVisible(false);
          return;
        }

        clearTimer(pendingVisibilityTimer);
        pendingVisibilityTimer = window.setTimeout(
          () => setPendingVisible(true),
          PENDING_VISIBILITY_DELAY_MS,
        );
        clearTimer(retryTimer);
        clearTimer(mutationTimer);
        mutationTimer = window.setTimeout(
          () => void runAutomaticSync(),
          MUTATION_DEBOUNCE_MS,
        );
      });
    });
    const offline = () => {
      clearTimer(retryTimer);
      setRecoveryState("idle");
      recovering = false;
      void getQueueCount(user.organizationId).then((count) => {
        setPendingCount(count);
        setPendingVisible(false);
        setPhase(count > 0 ? "local" : "offline");
      });
    };
    const online = () => void startRecovery("Back online");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);

    return () => {
      stopped = true;
      window.clearTimeout(initial);
      clearTimer(retryTimer);
      clearTimer(mutationTimer);
      clearTimer(pendingVisibilityTimer);
      clearTimer(recoveryTimer);
      stopAutomaticSync();
      stopDataListener();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [attemptSynchronization, user]);

  const value = useMemo(
    () => ({
      phase,
      error,
      pendingCount,
      pendingVisible,
      consecutiveFailures,
      recoveryState,
      recoveryCount,
      recoveryPrefix,
      syncNow,
    }),
    [
      phase,
      error,
      pendingCount,
      pendingVisible,
      consecutiveFailures,
      recoveryState,
      recoveryCount,
      recoveryPrefix,
      syncNow,
    ],
  );
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSynchronization() {
  const value = useContext(SyncContext);
  if (!value) {
    throw new Error("useSynchronization must be used inside SyncProvider.");
  }
  return value;
}
