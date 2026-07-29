"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { SyncPhase } from "@/lib/domain";
import { subscribeToQueuedMutations } from "@/lib/storage/data-events";
import { getQueueCount } from "@/lib/sync/queue";
import type { RecoveryState } from "@/lib/sync/presentation";
import {
  registerAutomaticSync,
  syncRetryDelay,
  synchronizeNow,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";
import type { SyncTrigger } from "@/lib/sync/upload-service";

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
  recoveryPrefix:
    | "Back online"
    | "Restoring saved changes"
    | "Saving changes"
    | "Manual sync";
  isSyncing: boolean;
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
    | "Back online"
    | "Restoring saved changes"
    | "Saving changes"
    | "Manual sync"
  >("Back online");
  const [isSyncing, setIsSyncing] = useState(false);
  const activeAttemptCount = useRef(0);
  const manualAttempt = useRef<Promise<SyncAttemptOutcome> | null>(null);
  const manualConfirmationTimer = useRef<number | undefined>(undefined);

  const attemptSynchronization = useCallback(
    async (
      drainQueue = false,
      trigger: SyncTrigger = "automatic",
    ): Promise<SyncAttemptOutcome> => {
      if (!user) return { status: "error", pendingCount: 0 };
      let count = await getQueueCount(user.organizationId);
      setPendingCount(count);
      if (!navigator.onLine) {
        setPhase(count > 0 ? "local" : "offline");
        setPendingVisible(false);
        return { status: "offline", pendingCount: count };
      }

      activeAttemptCount.current += 1;
      setIsSyncing(true);
      try {
        const cycles = drainQueue ? 2 : 1;
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const result =
            trigger === "manual"
              ? await synchronizeNow(user, { onPhase: setPhase })
              : await synchronizeOrganization(user, {
                  onPhase: setPhase,
                  trigger,
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
      } finally {
        activeAttemptCount.current -= 1;
        if (activeAttemptCount.current === 0) setIsSyncing(false);
      }
    },
    [user],
  );

  const syncNow = useCallback(
    () => {
      if (manualAttempt.current) return manualAttempt.current;
      if (manualConfirmationTimer.current) {
        window.clearTimeout(manualConfirmationTimer.current);
      }
      setRecoveryPrefix("Manual sync");
      setRecoveryState("syncing");
      const attempt = attemptSynchronization(true, "manual")
        .then((outcome) => {
          if (outcome.status === "synced") {
            setRecoveryState("complete");
            manualConfirmationTimer.current = window.setTimeout(
              () => setRecoveryState("idle"),
              RECOVERY_CONFIRMATION_MS,
            );
          } else {
            setRecoveryState("idle");
          }
          return outcome;
        })
        .finally(() => {
          manualAttempt.current = null;
        });
      manualAttempt.current = attempt;
      return attempt;
    },
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

    const runAutomaticSync = async (
      trigger: SyncTrigger = "automatic",
    ) => {
      if (stopped || !navigator.onLine) return;
      const outcome = await attemptSynchronization(false, trigger);
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
          () => void runAutomaticSync("automatic"),
          MUTATION_DEBOUNCE_MS,
        );
        return;
      }
      if (outcome.status === "error") {
        scheduleRetry(() => void runAutomaticSync("automatic"));
      }
    };

    const startRecovery = async (
      prefix: "Back online" | "Restoring saved changes",
      trigger: SyncTrigger,
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
      await runAutomaticSync(trigger);
    };

    const initialize = async () => {
      const count = await getQueueCount(user.organizationId);
      setPendingCount(count);
      if (!navigator.onLine) {
        setPhase(count > 0 ? "local" : "offline");
        return;
      }
      if (count > 0) {
        await startRecovery("Restoring saved changes", "startup");
      } else {
        await runAutomaticSync("startup");
      }
    };

    const initial = window.setTimeout(() => void initialize(), 0);
    const stopAutomaticSync = registerAutomaticSync(
      user,
      runAutomaticSync,
      { listenOnline: false },
    );
    const stopMutationListener = subscribeToQueuedMutations(() => {
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
        recovering = true;
        setRecoveryPrefix("Saving changes");
        setRecoveryCount(count);
        setRecoveryState("syncing");
        mutationTimer = window.setTimeout(
          () => void runAutomaticSync("automatic"),
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
    const online = () => void startRecovery("Back online", "online");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);

    return () => {
      stopped = true;
      window.clearTimeout(initial);
      clearTimer(retryTimer);
      clearTimer(mutationTimer);
      clearTimer(pendingVisibilityTimer);
      clearTimer(recoveryTimer);
      if (manualConfirmationTimer.current) {
        window.clearTimeout(manualConfirmationTimer.current);
      }
      stopAutomaticSync();
      stopMutationListener();
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
      isSyncing,
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
      isSyncing,
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
