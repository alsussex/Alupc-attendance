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
import { isAdmin } from "@/lib/auth/permissions";
import { enqueueChange } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";

const attendanceWriteChains = new Map<string, Promise<AttendanceRecord>>();

export async function listActiveMembers(organizationId: string) {
  return (await listMembers(organizationId)).filter(
    (person) => person.isActive,
  );
}

export async function listMembers(organizationId: string) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "people",
    "organizationId",
    organizationId,
  );
  return records
    .filter((person) => !person.deletedAt && person.personType === "member")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function getLastAttendanceDates(organizationId: string) {
  const database = await getDatabase();
  const [records, services] = await Promise.all([
    database.getAllFromIndex(
      "attendance",
      "organizationId",
      organizationId,
    ),
    database.getAllFromIndex("services", "organizationId", organizationId),
  ]);
  const serviceDates = new Map(
    services.map((service) => [service.id, service.serviceDate]),
  );
  const dates = new Map<string, string>();
  for (const record of records) {
    if (!record.present) continue;
    const serviceDate = serviceDates.get(record.serviceId);
    const current = dates.get(record.personId);
    if (serviceDate && (!current || serviceDate > current)) {
      dates.set(record.personId, serviceDate);
    }
  }
  return dates;
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
    version: existing?.version,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    displayName: makeDisplayName(input.firstName, input.lastName),
    personType: "member",
    isActive: existing?.isActive ?? true,
    inactiveAt: existing?.inactiveAt,
    deletedAt: existing?.deletedAt,
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
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can archive church members.");
  }
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (!person) throw new Error("Person not found");
  const timestamp = nowIso();
  const updated = {
    ...person,
    isActive: false,
    inactiveAt: person.inactiveAt ?? timestamp,
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
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

export async function restoreMember(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can restore church members.");
  }
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (!person || person.deletedAt) throw new Error("Person not found");
  const updated = {
    ...person,
    isActive: true,
    inactiveAt: null,
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
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

export async function removeMember(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can remove church members.");
  }
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (!person) throw new Error("Person not found");
  const timestamp = nowIso();
  const updated = {
    ...person,
    isActive: false,
    inactiveAt: person.inactiveAt ?? timestamp,
    deletedAt: timestamp,
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
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

export async function listServices(
  organizationId: string,
  includeArchived = false,
) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "services",
    "organizationId",
    organizationId,
  );
  return records
    .filter(
      (service) =>
        !service.deletedAt && (includeArchived || !service.isArchived),
    )
    .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
}

export async function saveService(
  user: UserContext,
  input: {
    id?: string;
    serviceDate: string;
    serviceType: ServiceType;
    customName?: string;
    serviceTime?: string;
    status: ServiceStatus;
  },
) {
  const database = await getDatabase();
  const existing = input.id ? await database.get("services", input.id) : undefined;
  const timestamp = nowIso();
  const service: ChurchService = {
    id: input.id ?? createId(),
    organizationId: user.organizationId,
    version: existing?.version,
    serviceDate: input.serviceDate,
    serviceType: input.serviceType,
    customName: input.customName?.trim() || undefined,
    serviceTime: input.serviceTime || undefined,
    status: input.status,
    isArchived: existing?.isArchived ?? false,
    deletedAt: existing?.deletedAt,
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

export async function setServiceArchived(
  user: UserContext,
  id: string,
  isArchived: boolean,
) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can archive services.");
  }
  const database = await getDatabase();
  const service = await database.get("services", id);
  if (!service || service.deletedAt) throw new Error("Service not found");
  const updated = {
    ...service,
    isArchived,
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("services", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: id,
    payload: toCloudRecord(updated),
  });
  announceDataChanged();
  return updated;
}

export async function removeService(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can remove services.");
  }
  const database = await getDatabase();
  const service = await database.get("services", id);
  if (!service) throw new Error("Service not found");
  const timestamp = nowIso();
  const updated = {
    ...service,
    isArchived: true,
    deletedAt: timestamp,
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
  await database.put("services", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: id,
    payload: toCloudRecord(updated),
  });
  announceDataChanged();
  return updated;
}

export async function getServiceAttendance(serviceId: string) {
  const database = await getDatabase();
  return database.getAllFromIndex("attendance", "serviceId", serviceId);
}

export function setMemberAttendance(
  user: UserContext,
  serviceId: string,
  personId: string,
  present: boolean,
) {
  const id = attendanceId(serviceId, personId);
  const previous = attendanceWriteChains.get(id);
  const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(
    async () => {
      const database = await getDatabase();
      const existing = await database.get("attendance", id);
      const timestamp = nowIso();
      const record: AttendanceRecord = {
        id,
        organizationId: user.organizationId,
        version: existing?.version,
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
    },
  );
  attendanceWriteChains.set(id, write);
  const cleanUp = () => {
    if (attendanceWriteChains.get(id) === write) {
      attendanceWriteChains.delete(id);
    }
  };
  void write.then(cleanUp, cleanUp);
  return write;
}

export async function addServiceVisitor(
  user: UserContext,
  serviceId: string,
  input: {
    firstName: string;
    lastName: string;
    saveAsMember: boolean;
    notes?: string;
    fallbackName?: string;
  },
) {
  const database = await getDatabase();
  const timestamp = nowIso();
  const firstName =
    input.firstName.trim() ||
    (!input.lastName.trim() ? input.fallbackName?.trim() || "Visitor" : "");
  const lastName = input.lastName.trim();
  let member: Person | undefined;
  if (input.saveAsMember) {
    if (!firstName || !lastName) {
      throw new Error("A first and last name are required to save a member.");
    }
    member = await saveMember(user, { firstName, lastName });
    await setMemberAttendance(user, serviceId, member.id, true);
  }

  const visitor: ServiceVisitor = {
    id: createId(),
    organizationId: user.organizationId,
    serviceId,
    firstName,
    lastName,
    displayName: makeDisplayName(firstName, lastName),
    savedAsMember: input.saveAsMember,
    memberPersonId: member?.id,
    notes: input.notes?.trim() || undefined,
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
  return (
    await database.getAllFromIndex("visitors", "serviceId", serviceId)
  ).filter((visitor) => !visitor.deletedAt);
}

export async function editServiceVisitor(
  user: UserContext,
  id: string,
  input: {
    firstName: string;
    lastName: string;
    notes?: string;
    fallbackName?: string;
  },
) {
  const database = await getDatabase();
  const visitor = await database.get("visitors", id);
  if (
    !visitor ||
    visitor.deletedAt ||
    visitor.organizationId !== user.organizationId
  ) {
    throw new Error("Visitor not found");
  }
  const firstName =
    input.firstName.trim() ||
    (!input.lastName.trim() ? input.fallbackName?.trim() || "Visitor" : "");
  const lastName = input.lastName.trim();
  const updated: ServiceVisitor = {
    ...visitor,
    firstName,
    lastName,
    displayName: makeDisplayName(firstName, lastName),
    notes: input.notes?.trim() || undefined,
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("visitors", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "service_visitors",
    recordId: updated.id,
    payload: toCloudRecord(updated),
    basePayload: toCloudRecord(visitor),
  });
  announceDataChanged();
  return updated;
}

export async function removeServiceVisitor(user: UserContext, id: string) {
  const database = await getDatabase();
  const visitor = await database.get("visitors", id);
  if (
    !visitor ||
    visitor.deletedAt ||
    visitor.organizationId !== user.organizationId
  ) {
    throw new Error("Visitor not found");
  }
  const timestamp = nowIso();
  const updated: ServiceVisitor = {
    ...visitor,
    deletedAt: timestamp,
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
  await database.put("visitors", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "service_visitors",
    recordId: updated.id,
    payload: toCloudRecord(updated),
    basePayload: toCloudRecord(visitor),
  });
  if (visitor.memberPersonId) {
    await setMemberAttendance(
      user,
      visitor.serviceId,
      visitor.memberPersonId,
      false,
    );
  }
  announceDataChanged();
  return updated;
}
