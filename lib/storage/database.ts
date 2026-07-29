"use client";

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AttendanceRecord,
  ChurchService,
  Person,
  ServiceVisitor,
  SyncQueueItem,
} from "@/lib/domain";

interface AttendanceDatabase extends DBSchema {
  people: {
    key: string;
    value: Person;
    indexes: { organizationId: string; displayName: string };
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
  syncQueue: {
    key: string;
    value: SyncQueueItem;
    indexes: { status: string; organizationId: string; recordId: string };
  };
}

let databasePromise: Promise<IDBPDatabase<AttendanceDatabase>> | null = null;

export function getDatabase() {
  if (!databasePromise) {
    databasePromise = openDB<AttendanceDatabase>("church-attendance", 1, {
      upgrade(database) {
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
      },
    });
  }
  return databasePromise;
}

export async function clearLocalDatabase() {
  const database = await getDatabase();
  const transaction = database.transaction(
    ["people", "services", "attendance", "visitors", "syncQueue"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("people").clear(),
    transaction.objectStore("services").clear(),
    transaction.objectStore("attendance").clear(),
    transaction.objectStore("visitors").clear(),
    transaction.objectStore("syncQueue").clear(),
    transaction.done,
  ]);
}
