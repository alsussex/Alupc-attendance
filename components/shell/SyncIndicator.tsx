"use client";

import { useSynchronization } from "@/components/sync/SyncProvider";
import {
  syncBannerPresentation,
  syncIndicatorPresentation,
} from "@/lib/sync/presentation";

export function SyncIndicator() {
  const synchronization = useSynchronization();
  const presentation = syncIndicatorPresentation(synchronization);
  return (
    <button
      className={`sync-indicator ${presentation.tone}`}
      type="button"
      onClick={() => void synchronization.syncNow()}
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
          onClick={() => void synchronization.syncNow()}
        >
          Sync now
        </button>
      )}
    </div>
  );
}
