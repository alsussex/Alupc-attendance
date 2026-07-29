"use client";

import { useCallback, useEffect, useState } from "react";
import type { SyncState } from "@/lib/domain";
import { useAuth } from "@/components/auth/AuthProvider";
import { getPendingChanges } from "@/lib/sync/queue";
import {
  registerAutomaticSync,
  syncPendingChanges,
} from "@/lib/sync/sync-service";

const labels: Record<SyncState, string> = {
  synced: "Online and synced",
  local: "Saved locally",
  pending: "Sync pending",
  error: "Sync error",
};

export function SyncIndicator() {
  const { user } = useAuth();
  const [state, setState] = useState<SyncState>("synced");

  const refresh = useCallback(async () => {
    if (!user) return;
    const queue = await getPendingChanges(user.organizationId);
    if (queue.some((item) => item.status === "error")) {
      setState("error");
    } else if (queue.length && navigator.onLine) {
      setState("pending");
    } else if (queue.length) {
      setState("local");
    } else {
      setState(navigator.onLine ? "synced" : "local");
    }
  }, [user]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const cleanup = registerAutomaticSync(refresh);
    const offline = () => void refresh();
    window.addEventListener("offline", offline);
    const interval = window.setInterval(refresh, 4000);
    return () => {
      cleanup();
      window.clearTimeout(initialRefresh);
      window.removeEventListener("offline", offline);
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <button
      className={`sync-indicator ${state}`}
      type="button"
      onClick={() => void syncPendingChanges().finally(refresh)}
      aria-label={`${labels[state]}. Activate to retry synchronization.`}
    >
      <span className="status-dot" aria-hidden="true" />
      {labels[state]}
    </button>
  );
}
