"use client";

import {
  createId,
  type AttendanceRecord,
  type ChurchService,
  type Person,
  type ServiceVisitor,
  type UserContext,
} from "@/lib/domain";
import { recordAuditEntry } from "@/lib/audit/audit-repository";
import { isAdmin } from "@/lib/auth/permissions";
import type { MonthlyAttendanceDataset } from "@/lib/exports/monthly-attendance-data";
import { loadCloudMonthlyAttendanceDataset } from "@/lib/exports/monthly-attendance-data";
import { attendanceServiceColumns } from "@/lib/exports/monthly-attendance-workbook";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";
import { getDatabase } from "@/lib/storage/database";
import { getSupabaseClient } from "@/lib/supabase/client";

export interface SnapshotService {
  id: string;
  date: string;
  time?: string;
  type: string;
  name: string;
  heading: string;
  unnamedVisitors: number;
  sundaySchoolKids: number;
  totalAttendance: number;
}

export interface SnapshotPerson {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  attendedServiceIds: string[];
}

export interface SnapshotVisitor {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  serviceId: string;
}

export interface MonthlySnapshotPayload {
  schemaVersion: 1;
  churchName: string;
  monthKey: string;
  year: number;
  month: number;
  services: SnapshotService[];
  members: SnapshotPerson[];
  visitors: SnapshotVisitor[];
}

export interface MonthlyAttendanceSnapshot {
  id: string;
  organizationId: string;
  monthStart: string;
  snapshotVersion: number;
  status: "finalized";
  payload: MonthlySnapshotPayload;
  notes?: string;
  serviceCount: number;
  totalAttendance: number;
  finalizedBy?: string;
  finalizedByName: string;
  finalizedAt: string;
  createdAt: string;
}

export interface SnapshotSource {
  list(organizationId: string): Promise<Record<string, unknown>[]>;
  find(organizationId: string, monthStart: string): Promise<Record<string, unknown> | undefined>;
  organizationName(organizationId: string): Promise<string>;
  insert(record: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function cloudSource(): SnapshotSource {
  return {
    async list(organizationId) {
      const { data, error } = await getSupabaseClient()
        .from("monthly_attendance_snapshots")
        .select("id,organization_id,month_start,snapshot_version,status,payload,notes,service_count,total_attendance,finalized_by,finalized_by_name,finalized_at,created_at")
        .eq("organization_id", organizationId)
        .eq("status", "finalized")
        .order("month_start", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Record<string, unknown>[];
    },
    async find(organizationId, monthStart) {
      const { data, error } = await getSupabaseClient()
        .from("monthly_attendance_snapshots")
        .select("id,organization_id,month_start,snapshot_version,status,payload,notes,service_count,total_attendance,finalized_by,finalized_by_name,finalized_at,created_at")
        .eq("organization_id", organizationId)
        .eq("month_start", monthStart)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? undefined) as Record<string, unknown> | undefined;
    },
    async organizationName(organizationId) {
      const { data, error } = await getSupabaseClient()
        .from("organizations")
        .select("id,name")
        .eq("id", organizationId)
        .single();
      if (error || !data) throw new Error(error?.message ?? "Organization could not be loaded.");
      return String(data.name);
    },
    async insert(record) {
      const { data, error } = await getSupabaseClient()
        .from("monthly_attendance_snapshots")
        .insert(record)
        .select("id,organization_id,month_start,snapshot_version,status,payload,notes,service_count,total_attendance,finalized_by,finalized_by_name,finalized_at,created_at")
        .single();
      if (error || !data) {
        if (error?.code === "23505") {
          throw new Error("A finalized snapshot already exists for this month.");
        }
        throw new Error(error?.message ?? "The monthly snapshot could not be finalized.");
      }
      return data as Record<string, unknown>;
    },
  };
}

function requiredString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new Error("A monthly snapshot record is incomplete.");
  }
  return value;
}

export function fromSnapshotCloudRecord(
  row: Record<string, unknown>,
  organizationId: string,
): MonthlyAttendanceSnapshot {
  if (requiredString(row, "organization_id") !== organizationId) {
    throw new Error("A monthly snapshot belongs to another organization.");
  }
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("A monthly snapshot payload is invalid.");
  }
  return {
    id: requiredString(row, "id"),
    organizationId,
    monthStart: requiredString(row, "month_start"),
    snapshotVersion: Number(row.snapshot_version),
    status: "finalized",
    payload: payload as MonthlySnapshotPayload,
    notes: typeof row.notes === "string" ? row.notes : undefined,
    serviceCount: Number(row.service_count),
    totalAttendance: Number(row.total_attendance),
    finalizedBy:
      typeof row.finalized_by === "string" ? row.finalized_by : undefined,
    finalizedByName: requiredString(row, "finalized_by_name"),
    finalizedAt: requiredString(row, "finalized_at"),
    createdAt: requiredString(row, "created_at"),
  };
}

function assertReportUser(user: UserContext) {
  if (user.role !== "admin" && user.role !== "attendance_taker") {
    throw new Error("Active church access is required.");
  }
}

export async function listMonthlySnapshots(
  user: UserContext,
  source: SnapshotSource = cloudSource(),
) {
  assertReportUser(user);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("An internet connection is required to load finalized snapshots.");
  }
  const rows = await source.list(user.organizationId);
  return rows.map((row) => fromSnapshotCloudRecord(row, user.organizationId));
}

export async function findMonthlySnapshot(
  user: UserContext,
  year: number,
  month: number,
  source: SnapshotSource = cloudSource(),
) {
  assertReportUser(user);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const row = await source.find(user.organizationId, monthStart);
  return row ? fromSnapshotCloudRecord(row, user.organizationId) : undefined;
}

export function buildMonthlySnapshotPayload(
  dataset: MonthlyAttendanceDataset,
  churchName: string,
): MonthlySnapshotPayload {
  if (dataset.dateRange) {
    throw new Error("Monthly snapshots require one complete calendar month.");
  }
  const serviceColumns = attendanceServiceColumns(dataset).filter(
    ({ service }) => service.status === "completed" && !service.deletedAt,
  );
  const eligibleServiceIds = new Set(
    serviceColumns.map(({ service }) => service.id),
  );
  const attendance = new Set(
    dataset.attendance
      .filter((record) => record.present)
      .map((record) => `${record.serviceId}:${record.personId}`),
  );
  return {
    schemaVersion: 1,
    churchName,
    monthKey: dataset.monthKey,
    year: dataset.year,
    month: dataset.month,
    services: serviceColumns.map(({ service, heading }) => {
      const summary = summarizeServiceAttendance(
        service,
        dataset.attendance,
        dataset.visitors,
      );
      return {
        id: service.id,
        date: service.serviceDate,
        time: service.serviceTime,
        type: service.serviceType,
        name: service.customName || service.serviceType,
        heading,
        unnamedVisitors: summary.unnamedVisitorCount,
        sundaySchoolKids: summary.sundaySchoolKidsCount,
        totalAttendance: summary.totalPresent,
      };
    }),
    members: dataset.members.map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      displayName: member.displayName,
      attendedServiceIds: serviceColumns
        .map(({ service }) => service)
        .filter((service) => attendance.has(`${service.id}:${member.id}`))
        .map((service) => service.id),
    })),
    visitors: dataset.visitors
      .filter(
        (visitor) =>
          eligibleServiceIds.has(visitor.serviceId) &&
          !visitor.deletedAt &&
          !visitor.savedAsMember,
      )
      .map((visitor) => ({
        id: visitor.id,
        firstName: visitor.firstName,
        lastName: visitor.lastName,
        displayName: visitor.displayName,
        serviceId: visitor.serviceId,
      })),
  };
}

export async function finalizeMonthlySnapshot(
  user: UserContext,
  year: number,
  month: number,
  notes = "",
  source: SnapshotSource = cloudSource(),
  loadDataset: (
    user: UserContext,
    year: number,
    month: number,
    completedOnly: boolean,
  ) => Promise<MonthlyAttendanceDataset> = loadCloudMonthlyAttendanceDataset,
) {
  if (!isAdmin(user)) {
    throw new Error("Administrator access is required to finalize snapshots.");
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("An internet connection is required to finalize a snapshot.");
  }
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  if (await source.find(user.organizationId, monthStart)) {
    throw new Error("A finalized snapshot already exists for this month.");
  }
  const database = await getDatabase();
  const profile = await database.get("profiles", user.userId);
  const finalizedByName = profile?.displayName?.trim() || user.email;
  const [dataset, churchName] = await Promise.all([
    loadDataset(user, year, month, true),
    source.organizationName(user.organizationId),
  ]);
  const payload = buildMonthlySnapshotPayload(dataset, churchName);
  const finalizedAt = new Date().toISOString();
  const record = await source.insert({
    id: createId(),
    organization_id: user.organizationId,
    month_start: monthStart,
    snapshot_version: 1,
    status: "finalized",
    payload,
    notes: notes.trim() || null,
    service_count: payload.services.length,
    total_attendance: payload.services.reduce(
      (total, service) => total + service.totalAttendance,
      0,
    ),
    finalized_by: user.userId,
    finalized_by_name: finalizedByName,
    finalized_at: finalizedAt,
    created_at: finalizedAt,
  });
  const snapshot = fromSnapshotCloudRecord(record, user.organizationId);
  await recordAuditEntry(user, {
    entityType: "report_snapshot",
    entityId: snapshot.id,
    action: "finalized",
    details: {
      month: dataset.monthKey,
      serviceCount: snapshot.serviceCount,
      totalAttendance: snapshot.totalAttendance,
    },
  });
  return snapshot;
}

export function snapshotToAttendanceDataset(
  snapshot: MonthlyAttendanceSnapshot,
): MonthlyAttendanceDataset {
  const timestamp = snapshot.finalizedAt;
  const services: ChurchService[] = snapshot.payload.services.map((service) => ({
    id: service.id,
    organizationId: snapshot.organizationId,
    serviceDate: service.date,
    serviceTime: service.time,
    serviceType: service.type,
    customName: service.name === service.type ? undefined : service.name,
    status: "completed",
    unnamedVisitorCount: service.unnamedVisitors,
    sundaySchoolKidsCount: service.sundaySchoolKids,
    isArchived: false,
    createdBy: snapshot.finalizedBy ?? snapshot.id,
    updatedBy: snapshot.finalizedBy ?? snapshot.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const members: Person[] = snapshot.payload.members.map((member) => ({
    id: member.id,
    organizationId: snapshot.organizationId,
    firstName: member.firstName,
    lastName: member.lastName,
    displayName: member.displayName,
    personType: "member",
    isActive: true,
    createdBy: snapshot.finalizedBy ?? snapshot.id,
    updatedBy: snapshot.finalizedBy ?? snapshot.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const attendance: AttendanceRecord[] = snapshot.payload.members.flatMap(
    (member) =>
      member.attendedServiceIds.map((serviceId) => ({
        id: `${serviceId}:${member.id}`,
        organizationId: snapshot.organizationId,
        serviceId,
        personId: member.id,
        present: true,
        createdBy: snapshot.finalizedBy ?? snapshot.id,
        updatedBy: snapshot.finalizedBy ?? snapshot.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
  );
  const visitors: ServiceVisitor[] = snapshot.payload.visitors.map((visitor) => ({
    id: visitor.id,
    organizationId: snapshot.organizationId,
    serviceId: visitor.serviceId,
    firstName: visitor.firstName,
    lastName: visitor.lastName,
    displayName: visitor.displayName,
    savedAsMember: false,
    createdBy: snapshot.finalizedBy ?? snapshot.id,
    updatedBy: snapshot.finalizedBy ?? snapshot.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  return {
    monthKey: snapshot.payload.monthKey,
    year: snapshot.payload.year,
    month: snapshot.payload.month,
    churchName: snapshot.payload.churchName,
    serviceHeadings: Object.fromEntries(
      snapshot.payload.services.map((service) => [service.id, service.heading]),
    ),
    services,
    members,
    attendance,
    visitors,
  };
}
