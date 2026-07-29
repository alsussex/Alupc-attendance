export type PersonType = "member" | "visitor";
export type ServiceStatus = "draft" | "completed";
export type UserRole = "admin" | "attendance_taker";
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

export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface AuditedRecord {
  id: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface Person extends AuditedRecord {
  firstName: string;
  lastName: string;
  displayName: string;
  personType: PersonType;
  isActive: boolean;
  inactiveAt?: string | null;
  deletedAt?: string;
}

export interface ChurchService extends AuditedRecord {
  serviceDate: string;
  serviceType: ServiceType;
  customName?: string;
  status: ServiceStatus;
  isArchived: boolean;
  deletedAt?: string;
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
}

export interface UserContext {
  userId: string;
  organizationId: string;
  email: string;
  role: UserRole;
}

export interface SyncQueueItem {
  id: string;
  organizationId: string;
  table: "people" | "services" | "service_attendance" | "service_visitors";
  operation: "upsert";
  recordId: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "error";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export const PULL_TABLES = [
  "organizations",
  "profiles",
  "people",
  "services",
  "service_attendance",
  "service_visitors",
] as const;

export type PullTable = (typeof PULL_TABLES)[number];

export interface SyncCursor {
  id: string;
  organizationId: string;
  table: PullTable;
  updatedAt: string;
  lastSuccessfulPullAt: string;
}

export interface SyncStatusRecord {
  id: string;
  organizationId: string;
  phase: SyncPhase;
  lastAttemptAt: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
}

export function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
