export type ServiceSaveStatus = "draft" | "completed";
export type ServiceSyncOutcome = "synced" | "pending" | "offline" | "error";

export function serviceSaveFeedback(
  status: ServiceSaveStatus,
  outcome: ServiceSyncOutcome,
) {
  if (status === "draft") {
    if (outcome === "synced") return "Saved as draft.";
    if (outcome === "offline") {
      return "Saved as draft on this device — will sync automatically.";
    }
    return "Saved as draft on this device — synchronization will retry automatically.";
  }

  if (outcome === "synced") return "Service completed.";
  if (outcome === "offline") {
    return "Completed on this device — will sync automatically.";
  }
  return "Completed on this device — synchronization will retry automatically.";
}
