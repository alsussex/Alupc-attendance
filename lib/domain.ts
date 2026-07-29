export type PersonType = "member" | "visitor";
export type ServiceStatus = "draft" | "completed";
export type SyncState = "synced" | "local" | "pending" | "error";

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

export interface Person extends AuditedRecord {
  firstName: string;
  lastName: string;
  displayName: string;
  personType: PersonType;
  isActive: boolean;
}

export interface ChurchService extends AuditedRecord {
  serviceDate: string;
  serviceType: ServiceType;
  customName?: string;
  status: ServiceStatus;
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
