export type PersonType = "member" | "visitor";
export type ServiceStatus = "draft" | "completed";
export type UserRole = "admin" | "attendance_taker";
export type ThemePreference = "light" | "dark" | "system";
export type SyncState = "synced" | "local" | "pending" | "error";
export type SyncPhase =
  | "loading"
  | "downloading"
  | "complete"
  | "local"
  | "pending"
  | "error"
  | "offline";

export const SERVICE_TYPES = [
  "Sunday Morning",
  "Sunday Evening",
  "Wednesday Bible Study",
  "Special Service",
  "Other",
] as const;

export type ServiceType = string;

export interface AuditedRecord {
  id: string;
  organizationId: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  version?: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Profile {
  id: string;
  organizationId: string;
  displayName?: string;
  role: "admin" | "attendance_taker";
  isActive: boolean;
  themePreference?: ThemePreference;
  canReopenCompletedServices?: boolean;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Person extends AuditedRecord {
  firstName: string;
  lastName: string;
  displayName: string;
  personType: PersonType;
  isActive: boolean;
  duplicateNameAllowed?: boolean;
  email?: string;
  phone?: string;
  inactiveAt?: string | null;
  restoredAt?: string | null;
  deletedAt?: string | null;
  mergedIntoId?: string | null;
  mergedFromIds?: string[];
}

export interface MemberPrivateDetails extends AuditedRecord {
  memberId: string;
  notes: string;
}

export interface ChurchService extends AuditedRecord {
  serviceDate: string;
  serviceType: ServiceType;
  customName?: string;
  serviceTime?: string;
  notes?: string;
  status: ServiceStatus;
  unnamedVisitorCount?: number;
  sundaySchoolKidsCount?: number;
  isArchived: boolean;
  deletedAt?: string | null;
}

export interface AttendanceRecord extends AuditedRecord {
  serviceId: string;
  personId: string;
  present: boolean;
}

export interface ServiceVisitor extends AuditedRecord {
  serviceId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  savedAsMember: boolean;
  memberPersonId?: string;
  notes?: string;
  deletedAt?: string | null;
}

export type AuditEntityType =
  | "service"
  | "attendance"
  | "visitor"
  | "member"
  | "user"
  | "settings"
  | "report_snapshot";

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  userId: string;
  userDisplayName: string;
  role: UserRole;
  occurredAt: string;
  deviceId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceTypeSetting {
  id: string;
  name: string;
  defaultTime?: string;
  enabled: boolean;
  system: boolean;
}

export interface ApplicationSettings {
  shortName: string;
  timezone: string;
  dateFormat: "month_day_year" | "day_month_year" | "iso";
  weekStart: "sunday" | "monday";
  serviceTypes: ServiceTypeSetting[];
  defaultServiceStatus: ServiceStatus;
  allowAdminReopenCompleted: boolean;
  confirmComplete: boolean;
  confirmArchive: boolean;
  attendanceSort: "first_name" | "last_name" | "recently_added";
  showAttendanceTotals: boolean;
  showPresentCount: boolean;
  showAbsentCount: boolean;
  showTotalMemberCount: boolean;
  warnZeroAttendance: boolean;
  showInactiveInAttendance: boolean;
  requireVisitorName: boolean;
  allowVisitorNotes: boolean;
  confirmVisitorRemoval: boolean;
  visitorLabel: string;
  showVisitorsSeparately: boolean;
  includeVisitorsInTotal: boolean;
}

export interface OrganizationSettings extends AuditedRecord {
  settings: ApplicationSettings;
}

export interface UserContext {
  userId: string;
  organizationId: string;
  email: string;
  displayName?: string;
  role: UserRole;
  canReopenCompletedServices?: boolean;
}

export interface SyncQueueItem {
  id: string;
  organizationId: string;
  table:
    | "organizations"
    | "profiles"
    | "organization_settings"
    | "member_private_details"
    | "people"
    | "services"
    | "service_attendance"
    | "service_visitors"
    | "audit_log";
  operation: "upsert";
  recordId: string;
  payload: Record<string, unknown>;
  basePayload?: Record<string, unknown>;
  baseVersion?: number;
  mutationToken?: string;
  status: "pending" | "processing" | "error" | "conflict";
  attempts: number;
  lastError?: string;
  conflict?: VisitorSyncConflict;
  createdAt: string;
  updatedAt: string;
}

export interface VisitorConflictField {
  field: string;
  localValue: unknown;
  serverValue: unknown;
}

export interface VisitorSyncConflict {
  kind: "visitor";
  visitorId: string;
  serviceId: string;
  organizationId: string;
  visitorName: string;
  localVersion?: number;
  serverVersion?: number;
  localUpdatedAt?: string;
  serverUpdatedAt?: string;
  localUpdatedBy?: string;
  serverUpdatedBy?: string;
  fields: VisitorConflictField[];
  serverRecord: Record<string, unknown>;
}

export const PULL_TABLES = [
  "organizations",
  "profiles",
  "organization_settings",
  "people",
  "member_private_details",
  "services",
  "service_attendance",
  "service_visitors",
  "audit_log",
] as const;

export type PullTable = (typeof PULL_TABLES)[number];

// Audit history is append-only and can become the largest organization table.
// It is loaded when an Admin opens history (and during an explicit full sync),
// rather than being downloaded on every routine application start.
export const BACKGROUND_PULL_TABLES = PULL_TABLES.filter(
  (table): table is Exclude<PullTable, "audit_log"> => table !== "audit_log",
);

// Realtime covers ordinary cross-device changes. Passive focus and scheduled
// reconciliation therefore only need the high-change operational tables.
export const OPERATIONAL_PULL_TABLES = [
  "people",
  "services",
  "service_attendance",
  "service_visitors",
] as const satisfies readonly PullTable[];

export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  shortName: "ALUPC",
  timezone: "America/Moncton",
  dateFormat: "month_day_year",
  weekStart: "sunday",
  serviceTypes: [
    {
      id: "sunday-morning",
      name: "Sunday Morning",
      defaultTime: "10:30",
      enabled: true,
      system: true,
    },
    {
      id: "sunday-evening",
      name: "Sunday Evening",
      defaultTime: "18:30",
      enabled: true,
      system: true,
    },
    {
      id: "wednesday-bible-study",
      name: "Wednesday Bible Study",
      defaultTime: "19:00",
      enabled: true,
      system: true,
    },
    {
      id: "special-service",
      name: "Special Service",
      enabled: true,
      system: true,
    },
  ],
  defaultServiceStatus: "draft",
  allowAdminReopenCompleted: true,
  confirmComplete: true,
  confirmArchive: true,
  attendanceSort: "first_name",
  showAttendanceTotals: true,
  showPresentCount: true,
  showAbsentCount: true,
  showTotalMemberCount: true,
  warnZeroAttendance: true,
  showInactiveInAttendance: false,
  requireVisitorName: true,
  allowVisitorNotes: true,
  confirmVisitorRemoval: true,
  visitorLabel: "Visitor",
  showVisitorsSeparately: true,
  includeVisitorsInTotal: true,
};

export interface SyncCursor {
  id: string;
  userId?: string;
  organizationId: string;
  table: PullTable;
  updatedAt: string;
  recordId?: string;
  lastSuccessfulPullAt: string;
}

export interface SyncStatusRecord {
  id: string;
  userId?: string;
  organizationId: string;
  phase: SyncPhase;
  lastAttemptAt: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
}

export interface MonthlyExportCoverage {
  id: string;
  userId: string;
  organizationId: string;
  monthKey: string;
  startDate?: string;
  endDateExclusive?: string;
  verifiedAt: string;
}

export function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeMemberCapitalization(value: string) {
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (
    collapsed &&
    (collapsed === collapsed.toLocaleLowerCase() ||
      collapsed === collapsed.toLocaleUpperCase())
  ) {
    return collapsed
      .toLocaleLowerCase()
      .replace(/(^|[\s'-])\p{L}/gu, (match) => match.toLocaleUpperCase());
  }
  return collapsed;
}

export function makeDisplayName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
}

export function createId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function attendanceId(serviceId: string, personId: string) {
  return `${serviceId}:${personId}`;
}

export function countAttendance(
  presentMemberIds: Iterable<string>,
  serviceOnlyVisitorCount: number,
) {
  return new Set(presentMemberIds).size + serviceOnlyVisitorCount;
}
