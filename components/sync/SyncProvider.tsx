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
import {
  registerAutomaticSync,
  syncRetryDelay,
  synchronizeOrganization,
} from "@/lib/sync/sync-service";

interface SyncContextValue {
  phase: SyncPhase;
  error: string | null;
  syncNow: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<SyncPhase>("loading");
  const [error, setError] = useState<string | null>(null);

  const attemptSynchronization = useCallback(async () => {
    if (!user || !navigator.onLine) return false;
    setError(null);
    try {
      const result = await synchronizeOrganization(user, {
        onPhase: setPhase,
      });
      if (result.upload.errors.length) {
        setError(result.upload.errors.join("\n"));
        setPhase("error");
        return false;
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Synchronization failed.",
      );
      setPhase("error");
      return false;
    }
  }, [user]);

  const syncNow = useCallback(async () => {
    if (!navigator.onLine) {
      const count = user ? await getQueueCount(user.organizationId) : 0;
      setPhase(count > 0 ? "local" : "offline");
      return;
    }
    await attemptSynchronization();
  }, [attemptSynchronization, user]);

  useEffect(() => {
    if (!user) return;
    let retryTimer: number | undefined;
    let saveDebounce: number | undefined;
    let failedAttempts = 0;
    let stopped = false;

    const clearRetry = () => {
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const runAutomaticSync = async () => {
      if (stopped || !navigator.onLine) return;
      const succeeded = await attemptSynchronization();
      if (stopped) return;
      if (succeeded) {
        failedAttempts = 0;
        clearRetry();
        return;
      }
      clearRetry();
      retryTimer = window.setTimeout(
        () => void runAutomaticSync(),
        syncRetryDelay(failedAttempts),
      );
      failedAttempts += 1;
    };

    const initialize = async () => {
      if (!navigator.onLine) {
        const count = await getQueueCount(user.organizationId);
        setPhase(count > 0 ? "local" : "offline");
        return;
      }
      await runAutomaticSync();
    };

    const initial = window.setTimeout(() => void initialize(), 0);
    const stopAutomaticSync = registerAutomaticSync(user, runAutomaticSync);
    const stopDataListener = subscribeToDataChanges(() => {
      void getQueueCount(user.organizationId).then((count) => {
        if (count === 0) return;
        if (!navigator.onLine) {
          setPhase("local");
          return;
        }
        setPhase("pending");
        if (saveDebounce) window.clearTimeout(saveDebounce);
        saveDebounce = window.setTimeout(() => void runAutomaticSync(), 300);
      });
    });
    const offline = () => {
      void getQueueCount(user.organizationId).then((count) =>
        setPhase(count > 0 ? "local" : "offline"),
      );
    };
    window.addEventListener("offline", offline);

    return () => {
      stopped = true;
      window.clearTimeout(initial);
      if (saveDebounce) window.clearTimeout(saveDebounce);
      clearRetry();
      stopAutomaticSync();
      stopDataListener();
      window.removeEventListener("offline", offline);
    };
  }, [attemptSynchronization, user]);

  const value = useMemo(
    () => ({ phase, error, syncNow }),
    [phase, error, syncNow],
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
