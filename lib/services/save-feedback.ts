export type ServiceSaveStatus = "draft" | "completed";
export type ServiceSyncOutcome =
  | "synced"
  | "pending"
  | "offline"
  | "error"
  | "blocked";

export function serviceSaveFeedback(
  status: ServiceSaveStatus,
  outcome: ServiceSyncOutcome,
) {
  if (status === "draft") {
    if (outcome === "synced") return "Saved as draft.";
    if (outcome === "offline") {
      return "Saved as draft on this device — will sync automatically.";
    }
    if (outcome === "blocked") {
      return "Saved as draft on this device — a synchronization conflict needs review.";
    }
    return "Saved as draft on this device — synchronization will retry automatically.";
  }

  if (outcome === "synced") return "Service completed.";
  if (outcome === "offline") {
    return "Completed on this device — will sync automatically.";
  }
  if (outcome === "blocked") {
    return "Completed on this device — a synchronization conflict needs review.";
  }
  return "Completed on this device — synchronization will retry automatically.";
}
