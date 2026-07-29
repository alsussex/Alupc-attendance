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

  const syncNow = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const result = await synchronizeOrganization(user, {
        onPhase: setPhase,
      });
      if (result.upload.errors.length) {
        setError(result.upload.errors.join("\n"));
        setPhase("error");
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Synchronization failed.",
      );
      setPhase("error");
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const initial = window.setTimeout(() => void syncNow(), 0);
    const stopAutomaticSync = registerAutomaticSync(user, syncNow);
    const stopDataListener = subscribeToDataChanges(() => {
      void getQueueCount(user.organizationId).then((count) => {
        if (count > 0) setPhase(navigator.onLine ? "pending" : "offline");
      });
    });
    const offline = () => setPhase("offline");
    window.addEventListener("offline", offline);
    return () => {
      window.clearTimeout(initial);
      stopAutomaticSync();
      stopDataListener();
      window.removeEventListener("offline", offline);
    };
  }, [syncNow, user]);

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
