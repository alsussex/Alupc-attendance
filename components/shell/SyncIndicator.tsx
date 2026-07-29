"use client";

import type { SyncPhase } from "@/lib/domain";
import { useSynchronization } from "@/components/sync/SyncProvider";

const labels: Record<SyncPhase, string> = {
  loading: "Loading church data",
  downloading: "Downloading updates",
  complete: "Sync complete",
  pending: "Sync pending",
  error: "Sync error",
  offline: "Offline — using saved data",
};

export function SyncIndicator() {
  const { phase, error, syncNow } = useSynchronization();
  const label = labels[phase];
  return (
    <button
      className={`sync-indicator ${phase}`}
      type="button"
      onClick={() => void syncNow()}
      aria-label={`${label}. Activate to synchronize now.`}
      title={error ?? "Activate to synchronize now"}
    >
      <span className="status-dot" aria-hidden="true" />
      {label}
    </button>
  );
}

export function SyncBanner() {
  const { phase, error, syncNow } = useSynchronization();
  if (phase === "complete") return null;
  return (
    <div className={`sync-banner ${phase}`} role={phase === "error" ? "alert" : "status"}>
      <span className="status-dot" aria-hidden="true" />
      <span>
        <strong>{labels[phase]}</strong>
        {phase === "error" && error ? <small>{error}</small> : null}
      </span>
      {(phase === "error" || phase === "offline" || phase === "pending") && (
        <button type="button" onClick={() => void syncNow()}>
          Try again
        </button>
      )}
    </div>
  );
}
