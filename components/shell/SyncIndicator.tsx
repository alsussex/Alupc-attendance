"use client";

import { useSynchronization } from "@/components/sync/SyncProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import {
  syncBannerPresentation,
  syncIndicatorPresentation,
} from "@/lib/sync/presentation";

export function SyncIndicator() {
  const synchronization = useSynchronization();
  const { showToast } = useToast();
  const presentation = syncIndicatorPresentation(synchronization);
  return (
    <button
      className={`sync-indicator ${presentation.tone}`}
      type="button"
      disabled={synchronization.isSyncing}
      onClick={() =>
        void synchronization.syncNow().then((outcome) => {
          if (outcome.status === "synced") {
            showToast("All changes synced.", { key: "manual-sync-complete" });
          }
        })
      }
      aria-label={`${presentation.label}. Activate to synchronize now.`}
      title={
        synchronization.consecutiveFailures >= 3
          ? synchronization.error ?? "Automatic synchronization will retry."
          : "Synchronization runs automatically. Activate for manual sync."
      }
    >
      <span className="status-dot" aria-hidden="true" />
      {presentation.label}
    </button>
  );
}

export function SyncBanner() {
  const synchronization = useSynchronization();
  const { showToast } = useToast();
  const presentation = syncBannerPresentation(synchronization);
  if (!presentation) return null;

  return (
    <div
      className={`sync-banner ${presentation.tone}`}
      role={presentation.tone === "error" ? "alert" : "status"}
    >
      <span className="status-dot" aria-hidden="true" />
      <strong>{presentation.message}</strong>
      {presentation.showManualAction && (
        <button
          type="button"
          disabled={synchronization.isSyncing}
          onClick={() =>
            void synchronization.syncNow().then((outcome) => {
              if (outcome.status === "synced") {
                showToast("All changes synced.", {
                  key: "manual-sync-complete",
                });
              }
            })
          }
        >
          {synchronization.isSyncing ? "Syncing…" : "Sync now"}
        </button>
      )}
    </div>
  );
}
