"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AttendanceRecord,
  AuditLogEntry,
  ChurchService,
  Organization,
  OrganizationSettings,
  MemberPrivateDetails,
  MonthlyExportCoverage,
  Person,
  Profile,
  ServiceVisitor,
  SyncCursor,
  SyncQueueItem,
  SyncStatusRecord,
} from "@/lib/domain";

export interface AttendanceDatabase extends DBSchema {
  organizations: {
    key: string;
    value: Organization;
  };
  organizationSettings: {
    key: string;
    value: OrganizationSettings;
    indexes: { organizationId: string };
  };
  profiles: {
    key: string;
    value: Profile;
    indexes: { organizationId: string };
  };
  people: {
    key: string;
    value: Person;
    indexes: { organizationId: string; displayName: string };
  };
  memberPrivateDetails: {
    key: string;
    value: MemberPrivateDetails;
    indexes: { organizationId: string; memberId: string };
  };
  services: {
    key: string;
    value: ChurchService;
    indexes: { organizationId: string; serviceDate: string };
  };
  attendance: {
    key: string;
    value: AttendanceRecord;
    indexes: { serviceId: string; organizationId: string };
  };
  visitors: {
    key: string;
    value: ServiceVisitor;
    indexes: { serviceId: string; organizationId: string };
  };
  auditLog: {
    key: string;
    value: AuditLogEntry;
    indexes: {
      organizationId: string;
      entityId: string;
      occurredAt: string;
      organizationOccurredAt: [string, string];
      organizationOccurredAtId: [string, string, string];
    };
  };
  syncQueue: {
    key: string;
    value: SyncQueueItem;
    indexes: { status: string; organizationId: string; recordId: string };
  };
  syncCursors: {
    key: string;
    value: SyncCursor;
    indexes: { organizationId: string };
  };
  syncStatus: {
    key: string;
    value: SyncStatusRecord;
    indexes: { organizationId: string };
  };
  monthlyExportCoverage: {
    key: string;
    value: MonthlyExportCoverage;
    indexes: { organizationId: string };
  };
}

let databasePromise: Promise<IDBPDatabase<AttendanceDatabase>> | null = null;

export function getDatabase() {
  if (!databasePromise) {
    databasePromise = openDB<AttendanceDatabase>("church-attendance", 6, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const people = database.createObjectStore("people", { keyPath: "id" });
          people.createIndex("organizationId", "organizationId");
          people.createIndex("displayName", "displayName");

          const services = database.createObjectStore("services", {
            keyPath: "id",
          });
          services.createIndex("organizationId", "organizationId");
          services.createIndex("serviceDate", "serviceDate");

          const attendance = database.createObjectStore("attendance", {
            keyPath: "id",
          });
          attendance.createIndex("serviceId", "serviceId");
          attendance.createIndex("organizationId", "organizationId");

          const visitors = database.createObjectStore("visitors", {
            keyPath: "id",
          });
          visitors.createIndex("serviceId", "serviceId");
          visitors.createIndex("organizationId", "organizationId");

          const queue = database.createObjectStore("syncQueue", { keyPath: "id" });
          queue.createIndex("status", "status");
          queue.createIndex("organizationId", "organizationId");
          queue.createIndex("recordId", "recordId");
        }

        if (oldVersion < 2) {
          database.createObjectStore("organizations", { keyPath: "id" });
          const profiles = database.createObjectStore("profiles", { keyPath: "id" });
          profiles.createIndex("organizationId", "organizationId");
          const cursors = database.createObjectStore("syncCursors", { keyPath: "id" });
          cursors.createIndex("organizationId", "organizationId");
          const status = database.createObjectStore("syncStatus", { keyPath: "id" });
          status.createIndex("organizationId", "organizationId");
        }
        if (oldVersion < 3) {
          const organizationSettings = database.createObjectStore(
            "organizationSettings",
            { keyPath: "id" },
          );
          organizationSettings.createIndex(
            "organizationId",
            "organizationId",
          );
        }
        if (oldVersion < 4) {
          const auditLog = database.createObjectStore("auditLog", {
            keyPath: "id",
          });
          auditLog.createIndex("organizationId", "organizationId");
          auditLog.createIndex("entityId", "entityId");
          auditLog.createIndex("occurredAt", "occurredAt");
          auditLog.createIndex(
            "organizationOccurredAt",
            ["organizationId", "occurredAt"],
          );
          auditLog.createIndex(
            "organizationOccurredAtId",
            ["organizationId", "occurredAt", "id"],
          );
        }
        if (oldVersion < 5) {
          const privateDetails = database.createObjectStore(
            "memberPrivateDetails",
            { keyPath: "id" },
          );
          privateDetails.createIndex("organizationId", "organizationId");
          privateDetails.createIndex("memberId", "memberId");
        }
        if (oldVersion < 6) {
          const monthlyCoverage = database.createObjectStore(
            "monthlyExportCoverage",
            { keyPath: "id" },
          );
          monthlyCoverage.createIndex("organizationId", "organizationId");
        }
      },
    });
  }
  return databasePromise;
}

export async function closeLocalDatabaseConnection() {
  if (!databasePromise) return;
  const database = await databasePromise;
  database.close();
  databasePromise = null;
}

export async function clearLocalDatabase() {
  const database = await getDatabase();
  const transaction = database.transaction(
    [
      "organizations",
      "organizationSettings",
      "profiles",
      "people",
      "memberPrivateDetails",
      "services",
      "attendance",
      "visitors",
      "auditLog",
      "syncQueue",
      "syncCursors",
      "syncStatus",
      "monthlyExportCoverage",
    ],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("organizations").clear(),
    transaction.objectStore("organizationSettings").clear(),
    transaction.objectStore("profiles").clear(),
    transaction.objectStore("people").clear(),
    transaction.objectStore("memberPrivateDetails").clear(),
    transaction.objectStore("services").clear(),
    transaction.objectStore("attendance").clear(),
    transaction.objectStore("visitors").clear(),
    transaction.objectStore("auditLog").clear(),
    transaction.objectStore("syncQueue").clear(),
    transaction.objectStore("syncCursors").clear(),
    transaction.objectStore("syncStatus").clear(),
    transaction.objectStore("monthlyExportCoverage").clear(),
    transaction.done,
  ]);
}
