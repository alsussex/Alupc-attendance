const SERVICE_FIELDS = [
  "service_date",
  "service_type",
  "custom_name",
  "service_time",
  "notes",
  "status",
  "unnamed_visitor_count",
  "sunday_school_kids_count",
  "is_archived",
  "deleted_at",
] as const;

type ServiceField = (typeof SERVICE_FIELDS)[number];

export type ServiceReconciliation =
  | { kind: "satisfied"; payload: Record<string, unknown> }
  | { kind: "server"; payload: Record<string, unknown> }
  | { kind: "retry"; payload: Record<string, unknown> }
  | { kind: "conflict"; fields: ServiceField[] };

function normalized(field: ServiceField, value: unknown) {
  if (field === "unnamed_visitor_count" || field === "sunday_school_kids_count") {
    return typeof value === "number" ? value : 0;
  }
  if (field === "is_archived") return value === true;
  if (field === "service_time" && typeof value === "string") {
    return value.slice(0, 5);
  }
  return value ?? null;
}

function same(field: ServiceField, left: unknown, right: unknown) {
  return normalized(field, left) === normalized(field, right);
}

function meaningfulEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return SERVICE_FIELDS.every((field) => same(field, left[field], right[field]));
}

function newerLocalReopen(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
) {
  if (local.status !== "draft" || remote.status !== "completed") return false;
  const localTime = Date.parse(String(local.updated_at ?? ""));
  const remoteTime = Date.parse(String(remote.updated_at ?? ""));
  return Number.isFinite(localTime) && Number.isFinite(remoteTime) && localTime > remoteTime;
}

/**
 * Reconciles a queued service edit against the current server row.
 *
 * Completed wins over an older draft, while a deliberate reopen based on a
 * completed record remains valid. Counter edits are merged as deltas from the
 * common base. Same-field differences elsewhere remain genuine conflicts.
 */
export function reconcileServiceMutation(
  local: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
  remote: Record<string, unknown>,
): ServiceReconciliation {
  if (meaningfulEqual(local, remote)) {
    return { kind: "satisfied", payload: remote };
  }

  if (!base) {
    const differing = SERVICE_FIELDS.filter(
      (field) => !same(field, local[field], remote[field]),
    );
    if (differing.length === 1 && differing[0] === "status") {
      if (local.status === "completed" || newerLocalReopen(local, remote)) {
        return { kind: "retry", payload: { ...local } };
      }
      if (remote.status === "completed") {
        return { kind: "server", payload: remote };
      }
    }
    return { kind: "conflict", fields: differing };
  }

  const merged = { ...local };
  const conflicts: ServiceField[] = [];
  for (const field of SERVICE_FIELDS) {
    const localChanged = !same(field, local[field], base[field]);
    const remoteChanged = !same(field, remote[field], base[field]);
    if (same(field, local[field], remote[field])) {
      merged[field] = normalized(field, local[field]);
      continue;
    }
    if (!localChanged) {
      merged[field] = normalized(field, remote[field]);
      continue;
    }
    if (!remoteChanged) {
      merged[field] = normalized(field, local[field]);
      continue;
    }
    if (field === "status") {
      // Completion beats an older draft. A reopen is safe only when the common
      // base was already completed, which proves the draft is intentional.
      merged[field] = base.status === "completed" ? "draft" : "completed";
      continue;
    }
    if (
      field === "unnamed_visitor_count" ||
      field === "sunday_school_kids_count"
    ) {
      const baseCount = Number(normalized(field, base[field]));
      const localCount = Number(normalized(field, local[field]));
      const remoteCount = Number(normalized(field, remote[field]));
      merged[field] = Math.max(
        0,
        baseCount + (localCount - baseCount) + (remoteCount - baseCount),
      );
      continue;
    }
    conflicts.push(field);
  }
  if (conflicts.length > 0) return { kind: "conflict", fields: conflicts };
  return meaningfulEqual(merged, remote)
    ? { kind: "satisfied", payload: remote }
    : { kind: "retry", payload: merged };
}

export function serviceConflictFieldLabels(fields: ServiceField[]) {
  const labels: Record<ServiceField, string> = {
    service_date: "date",
    service_type: "type",
    custom_name: "name",
    service_time: "time",
    notes: "notes",
    status: "status",
    unnamed_visitor_count: "unnamed visitors",
    sunday_school_kids_count: "children’s attendance",
    is_archived: "archive status",
    deleted_at: "deletion status",
  };
  return fields.map((field) => labels[field]);
}
