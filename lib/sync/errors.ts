import type { SyncQueueItem } from "@/lib/domain";

export type SyncErrorCategory =
  | "authentication"
  | "permission"
  | "validation"
  | "network"
  | "conflict"
  | "legacy"
  | "server"
  | "unknown";

const SENSITIVE_DETAIL_PATTERNS = [
  /bearer\s+[a-z0-9._~-]+/gi,
  /(?:access|refresh|auth|api|service[_ -]?role)?token\s*[:=]\s*[^\s,;]+/gi,
  /(?:password|secret|apikey|api_key|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /[?&](?:token|access_token|refresh_token|apikey|api_key)=[^&\s]+/gi,
];

export function syncDiagnosticDetails(message?: string) {
  if (!message?.trim()) return undefined;
  let safeMessage = message.replace(/\s+/g, " ").trim();
  for (const pattern of SENSITIVE_DETAIL_PATTERNS) {
    safeMessage = safeMessage.replace(pattern, "[redacted]");
  }
  const code = safeMessage.match(
    /\b(?:SYNC_[A-Z_]+|PGRST\d+|[0-9A-Z]{5}|HTTP\s*[45]\d\d)\b/i,
  )?.[0];
  return {
    code,
    message:
      safeMessage.length > 400
        ? `${safeMessage.slice(0, 397)}...`
        : safeMessage,
  };
}

export function syncErrorCategory(message: string, code?: string) {
  const value = `${code ?? ""} ${message}`.toLocaleLowerCase();
  if (
    /jwt|token|session|authentication|unauthorized|pgrst301|401/.test(value)
  ) {
    return "authentication" satisfies SyncErrorCategory;
  }
  if (/row-level security|permission|forbidden|42501|403/.test(value)) {
    return "permission" satisfies SyncErrorCategory;
  }
  if (
    /not-null|check constraint|invalid input|missing|required|23502|23514|22p02/.test(
      value,
    )
  ) {
    return "validation" satisfies SyncErrorCategory;
  }
  if (/fetch|network|offline|timed out|timeout|connection/.test(value)) {
    return "network" satisfies SyncErrorCategory;
  }
  if (/sync_conflict|conflict|changed on another device/.test(value)) {
    return "conflict" satisfies SyncErrorCategory;
  }
  if (/legacy|cloud record is missing|unsupported type/.test(value)) {
    return "legacy" satisfies SyncErrorCategory;
  }
  if (/50\d|server|gateway|temporar|unavailable/.test(value)) {
    return "server" satisfies SyncErrorCategory;
  }
  return "unknown" satisfies SyncErrorCategory;
}

function entityLabel(table: SyncQueueItem["table"]) {
  if (table === "people") return "Member";
  if (table === "service_visitors") return "Visitor";
  if (table === "services") return "Service";
  if (table === "service_attendance") return "Attendance entry";
  if (table === "organization_settings") return "Church settings";
  if (table === "profiles") return "Appearance preference";
  if (table === "audit_log") return "History entry";
  return "Church record";
}

export function humanReadableSyncError(input: {
  item: Pick<SyncQueueItem, "table" | "recordId">;
  message: string;
  code?: string;
  recordName?: string;
}) {
  const category = syncErrorCategory(input.message, input.code);
  const entity = entityLabel(input.item.table);
  const namedEntity = input.recordName
    ? `${entity} “${input.recordName}”`
    : entity;
  if (category === "authentication") {
    return "Your sign-in needs attention before saved changes can sync. Sign in again; your changes remain safely on this device.";
  }
  if (category === "permission") {
    return `${namedEntity} could not sync because this account does not have permission for that change. Ask an administrator for help.`;
  }
  if (category === "validation") {
    return `${namedEntity} could not sync because the saved record is incomplete or invalid. Open it, review the details, and save it again.`;
  }
  if (category === "network") {
    return "Changes are safely saved on this device and will sync automatically when the connection is available.";
  }
  if (category === "conflict") {
    if (input.item.table === "service_visitors" && input.recordName) {
      return `${input.recordName} has changes from another device. Review them before finishing this service.`;
    }
    return `${namedEntity} has newer changes from another device. Review the conflict before trying again.`;
  }
  if (category === "legacy") {
    return `${namedEntity} uses an older saved format. Open the record, review it, and save it again.`;
  }
  if (category === "server") {
    return "The church data service is temporarily unavailable. Changes remain saved on this device and will retry automatically.";
  }
  return `${namedEntity} could not sync. It remains safely saved on this device and automatic retry will continue.`;
}
