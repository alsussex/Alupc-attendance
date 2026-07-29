"use client";

export type AttendanceReconciliation =
  | { kind: "satisfied" }
  | { kind: "apply-local" }
  | { kind: "conflict" };

function presentValue(record: Record<string, unknown> | undefined) {
  return typeof record?.present === "boolean" ? record.present : undefined;
}

/**
 * Reconciles only the user-controlled attendance value. Server-owned metadata
 * such as version, updated_at, and mutation receipts must never create a
 * checkbox conflict by themselves.
 */
export function reconcileAttendanceMutation(
  local: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  server: Record<string, unknown>,
): AttendanceReconciliation {
  const localPresent = presentValue(local);
  const serverPresent = presentValue(server);
  if (localPresent === undefined || serverPresent === undefined) {
    return { kind: "conflict" };
  }
  if (localPresent === serverPresent) {
    return { kind: "satisfied" };
  }

  const basePresent = presentValue(base);
  if (basePresent === undefined) {
    return { kind: "conflict" };
  }
  const localChanged = localPresent !== basePresent;
  const serverChanged = serverPresent !== basePresent;

  if (localChanged && !serverChanged) {
    return { kind: "apply-local" };
  }
  if (!localChanged && serverChanged) {
    return { kind: "satisfied" };
  }
  return { kind: "conflict" };
}
