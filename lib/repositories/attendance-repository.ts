"use client";

import {
  attendanceId,
  createId,
  makeDisplayName,
  normalizeName,
  nowIso,
  type AttendanceRecord,
  type ChurchService,
  type Person,
  type ServiceStatus,
  type ServiceType,
  type ServiceVisitor,
  type UserContext,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { enqueueChange } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";

export async function listActiveMembers(organizationId: string) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "people",
    "organizationId",
    organizationId,
  );
  return records
    .filter((person) => person.isActive && person.personType === "member")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function findDuplicateMember(
  organizationId: string,
  displayName: string,
  excludeId?: string,
) {
  const normalized = normalizeName(displayName);
  return (await listActiveMembers(organizationId)).find(
    (person) =>
      person.id !== excludeId && normalizeName(person.displayName) === normalized,
  );
}

export async function saveMember(
  user: UserContext,
  input: { id?: string; firstName: string; lastName: string },
) {
  const database = await getDatabase();
  const existing = input.id ? await database.get("people", input.id) : undefined;
  const timestamp = nowIso();
  const person: Person = {
    id: input.id ?? createId(),
    organizationId: user.organizationId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    displayName: makeDisplayName(input.firstName, input.lastName),
    personType: "member",
    isActive: existing?.isActive ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy: existing?.createdBy ?? user.userId,
    updatedBy: user.userId,
  };
  await database.put("people", person);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "people",
    recordId: person.id,
    payload: toCloudRecord(person),
  });
  announceDataChanged();
  return person;
}

export async function markMemberInactive(user: UserContext, id: string) {
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (!person) throw new Error("Person not found");
  const updated = { ...person, isActive: false, updatedAt: nowIso(), updatedBy: user.userId };
  await database.put("people", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "people",
    recordId: id,
    payload: toCloudRecord(updated),
  });
  announceDataChanged();
  return updated;
}

export async function listServices(organizationId: string) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "services",
    "organizationId",
    organizationId,
  );
  return records.sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
}

export async function saveService(
  user: UserContext,
  input: {
    id?: string;
    serviceDate: string;
    serviceType: ServiceType;
    customName?: string;
    status: ServiceStatus;
  },
) {
  const database = await getDatabase();
  const existing = input.id ? await database.get("services", input.id) : undefined;
  const timestamp = nowIso();
  const service: ChurchService = {
    id: input.id ?? createId(),
    organizationId: user.organizationId,
    serviceDate: input.serviceDate,
    serviceType: input.serviceType,
    customName: input.customName?.trim() || undefined,
    status: input.status,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy: existing?.createdBy ?? user.userId,
    updatedBy: user.userId,
  };
  await database.put("services", service);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: service.id,
    payload: toCloudRecord(service),
  });
  announceDataChanged();
  return service;
}

export async function getServiceAttendance(serviceId: string) {
  const database = await getDatabase();
  return database.getAllFromIndex("attendance", "serviceId", serviceId);
}

export async function setMemberAttendance(
  user: UserContext,
  serviceId: string,
  personId: string,
  present: boolean,
) {
  const database = await getDatabase();
  const id = attendanceId(serviceId, personId);
  const existing = await database.get("attendance", id);
  const timestamp = nowIso();
  const record: AttendanceRecord = {
    id,
    organizationId: user.organizationId,
    serviceId,
    personId,
    present,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy: existing?.createdBy ?? user.userId,
    updatedBy: user.userId,
  };
  await database.put("attendance", record);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "service_attendance",
    recordId: id,
    payload: toCloudRecord(record),
  });
  announceDataChanged();
  return record;
}

export async function addServiceVisitor(
  user: UserContext,
  serviceId: string,
  input: { firstName: string; lastName: string; saveAsMember: boolean },
) {
  const database = await getDatabase();
  const timestamp = nowIso();
  let member: Person | undefined;
  if (input.saveAsMember) {
    member = await saveMember(user, input);
    await setMemberAttendance(user, serviceId, member.id, true);
  }

  const visitor: ServiceVisitor = {
    id: createId(),
    organizationId: user.organizationId,
    serviceId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    displayName: makeDisplayName(input.firstName, input.lastName),
    savedAsMember: input.saveAsMember,
    memberPersonId: member?.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: user.userId,
    updatedBy: user.userId,
  };
  await database.put("visitors", visitor);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "service_visitors",
    recordId: visitor.id,
    payload: toCloudRecord(visitor),
  });
  announceDataChanged();
  return { visitor, member };
}

export async function listServiceVisitors(serviceId: string) {
  const database = await getDatabase();
  return database.getAllFromIndex("visitors", "serviceId", serviceId);
}
