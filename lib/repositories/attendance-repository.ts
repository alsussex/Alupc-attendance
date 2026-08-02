"use client";

import {
  attendanceId,
  createId,
  makeDisplayName,
  normalizeName,
  normalizeMemberCapitalization,
  nowIso,
  type AttendanceRecord,
  type ChurchService,
  type Person,
  type MemberPrivateDetails,
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
import { recordAuditEntry } from "@/lib/audit/audit-repository";
import { memberContactValidation } from "@/lib/people/member-contact";
import { childProgramForService } from "@/lib/services/child-program";
import {
  currentUndoDirection,
  recordUndoAction,
  runWithoutUndoCapture,
} from "@/lib/undo/undo-service";

const attendanceWriteChains = new Map<string, Promise<AttendanceRecord>>();
const serviceCountWriteChains = new Map<string, Promise<ChurchService>>();
export const COMPLETED_SERVICE_LOCK_MESSAGE =
  "This service is completed and locked. Reopen it before making changes.";

function undoAuditDetails() {
  const historyOperation = currentUndoDirection();
  return historyOperation ? { historyOperation } : {};
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function serviceEditable(service: ChurchService | undefined) {
  return Boolean(service && !service.deletedAt && service.status !== "completed");
}

function serviceCloudRecord(service: ChurchService) {
  return {
    ...toCloudRecord(service),
    custom_name: service.customName ?? null,
    service_time: service.serviceTime ?? null,
    notes: service.notes ?? null,
    deleted_at: service.deletedAt ?? null,
  };
}

function visitorCloudRecord(visitor: ServiceVisitor) {
  return {
    ...toCloudRecord(visitor),
    member_person_id: visitor.memberPersonId ?? null,
    notes: visitor.notes ?? null,
    deleted_at: visitor.deletedAt ?? null,
  };
}

async function requireEditableService(
  user: UserContext,
  serviceId: string,
) {
  const database = await getDatabase();
  const service = await database.get("services", serviceId);
  if (
    !service ||
    service.deletedAt ||
    service.organizationId !== user.organizationId
  ) {
    throw new Error("Service not found");
  }
  if (service.status === "completed") {
    throw new Error(COMPLETED_SERVICE_LOCK_MESSAGE);
  }
  return service;
}

export async function listActiveMembers(organizationId: string) {
  return (await listMembers(organizationId)).filter(
    (person) => person.isActive,
  );
}

export async function listMembers(organizationId: string) {
  return (await listMemberCandidates(organizationId))
    .filter((person) => !person.deletedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listMemberCandidates(organizationId: string) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "people",
    "organizationId",
    organizationId,
  );
  return records
    .filter(
      (person) =>
        person.organizationId === organizationId &&
        person.personType === "member",
    );
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

export async function getMemberAttendanceCounts(organizationId: string) {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "attendance",
    "organizationId",
    organizationId,
  );
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.present) {
      counts.set(record.personId, (counts.get(record.personId) ?? 0) + 1);
    }
  }
  return counts;
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

export async function findExactMemberMatches(
  organizationId: string,
  displayName: string,
  excludeId?: string,
) {
  const normalized = normalizeName(displayName);
  return (await listMemberCandidates(organizationId)).filter(
    (person) =>
      person.id !== excludeId &&
      !person.mergedIntoId &&
      normalizeName(person.displayName) === normalized,
  );
}

export async function saveMember(
  user: UserContext,
  input: {
    id?: string;
    firstName: string;
    lastName: string;
    allowDuplicate?: boolean;
    email?: string;
    phone?: string;
  },
) {
  const database = await getDatabase();
  const existing = input.id ? await database.get("people", input.id) : undefined;
  if (
    existing &&
    (existing.organizationId !== user.organizationId ||
      existing.personType !== "member")
  ) {
    throw new Error("Member not found.");
  }
  const contactError = memberContactValidation(input);
  if (contactError) throw new Error(contactError);
  const timestamp = nowIso();
  const firstName = normalizeMemberCapitalization(input.firstName);
  const lastName = normalizeMemberCapitalization(input.lastName);
  const person: Person = {
    id: input.id ?? createId(),
    organizationId: user.organizationId,
    version: existing?.version,
    firstName,
    lastName,
    displayName: makeDisplayName(firstName, lastName),
    personType: "member",
    isActive: existing?.isActive ?? true,
    duplicateNameAllowed:
      input.allowDuplicate ?? existing?.duplicateNameAllowed ?? false,
    email: input.email?.trim().toLocaleLowerCase() || undefined,
    phone: input.phone?.trim() || undefined,
    inactiveAt: existing?.inactiveAt,
    restoredAt: existing?.restoredAt,
    deletedAt: existing?.deletedAt,
    mergedIntoId: existing?.mergedIntoId,
    mergedFromIds: existing?.mergedFromIds,
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
  const changedFields = !existing
    ? ["name", ...(person.email ? ["email"] : []), ...(person.phone ? ["phone"] : [])]
    : [
        ...(existing.firstName !== person.firstName ||
        existing.lastName !== person.lastName
          ? ["name"]
          : []),
        ...(existing.email !== person.email ? ["email"] : []),
        ...(existing.phone !== person.phone ? ["phone"] : []),
      ];
  if (!existing || changedFields.length > 0) {
    await recordAuditEntry(user, {
      entityType: "member",
      entityId: person.id,
      action: existing ? "edited" : "added",
      details: {
        name: person.displayName,
        changedFields,
        ...(existing
          ? { from: existing.displayName, to: person.displayName }
          : {}),
      },
    });
  }
  announceDataChanged();
  return person;
}

export async function getMemberPrivateDetails(
  user: UserContext,
  memberId: string,
) {
  if (!isAdmin(user)) return undefined;
  const database = await getDatabase();
  const details = await database.get("memberPrivateDetails", memberId);
  return details?.organizationId === user.organizationId
    ? details
    : undefined;
}

export async function saveMemberPrivateDetails(
  user: UserContext,
  memberId: string,
  notes: string,
) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can update private member notes.");
  }
  const validation = memberContactValidation({ notes });
  if (validation) throw new Error(validation);
  const database = await getDatabase();
  const member = await database.get("people", memberId);
  if (
    !member ||
    member.organizationId !== user.organizationId ||
    member.personType !== "member"
  ) {
    throw new Error("Member not found.");
  }
  const existing = await database.get("memberPrivateDetails", memberId);
  const timestamp = nowIso();
  const record: MemberPrivateDetails = {
    id: memberId,
    memberId,
    organizationId: user.organizationId,
    version: existing?.version,
    notes: notes.trim(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy: existing?.createdBy ?? user.userId,
    updatedBy: user.userId,
  };
  await database.put("memberPrivateDetails", record);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "member_private_details",
    recordId: memberId,
    payload: toCloudRecord(record),
    basePayload: existing ? toCloudRecord(existing) : undefined,
  });
  if (!existing || existing.notes !== record.notes) {
    await recordAuditEntry(user, {
      entityType: "member",
      entityId: memberId,
      action: "edited",
      details: {
        name: member.displayName,
        changedFields: ["notes"],
      },
    });
  }
  announceDataChanged();
  return record;
}

export async function markMemberInactive(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can archive church members.");
  }
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (
    !person ||
    person.organizationId !== user.organizationId ||
    person.personType !== "member"
  ) {
    throw new Error("Person not found");
  }
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
  if (person.isActive) {
    await recordAuditEntry(user, {
      entityType: "member",
      entityId: id,
      action: "deactivated",
      details: { name: updated.displayName, ...undoAuditDetails() },
    });
  }
  announceDataChanged();
  if (person.isActive) {
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "member",
      entityId: id,
      label: `Archive ${updated.displayName}`,
      canUndo: async () => {
        const current = await (await getDatabase()).get("people", id);
        return Boolean(
          current &&
            current.organizationId === user.organizationId &&
            !current.isActive &&
            !current.deletedAt,
        );
      },
      canRedo: async () => {
        const current = await (await getDatabase()).get("people", id);
        return Boolean(
          current &&
            current.organizationId === user.organizationId &&
            current.isActive &&
            !current.deletedAt,
        );
      },
      undo: () => restoreMember(user, id).then(() => undefined),
      redo: () => markMemberInactive(user, id).then(() => undefined),
    });
  }
  return updated;
}

export async function restoreMember(user: UserContext, id: string) {
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (
    !person ||
    person.organizationId !== user.organizationId ||
    person.personType !== "member"
  ) {
    throw new Error("Person not found");
  }
  const updated = {
    ...person,
    isActive: true,
    inactiveAt: null,
    restoredAt: nowIso(),
    deletedAt: null,
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
  if (!person.isActive) {
    await recordAuditEntry(user, {
      entityType: "member",
      entityId: id,
      action: person.deletedAt ? "restored" : "reactivated",
      details: { name: updated.displayName, ...undoAuditDetails() },
    });
  }
  announceDataChanged();
  if (!person.isActive || person.deletedAt) {
    const restoredRemovedMember = Boolean(person.deletedAt);
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "member",
      entityId: id,
      label: `Restore ${updated.displayName}`,
      canUndo: async () => {
        const current = await (await getDatabase()).get("people", id);
        return Boolean(
          current &&
            current.organizationId === user.organizationId &&
            current.isActive &&
            !current.deletedAt,
        );
      },
      canRedo: async () => {
        const current = await (await getDatabase()).get("people", id);
        return Boolean(
          current &&
            current.organizationId === user.organizationId &&
            !current.isActive &&
            (restoredRemovedMember ? Boolean(current.deletedAt) : !current.deletedAt),
        );
      },
      undo: () =>
        (restoredRemovedMember
          ? removeMember(user, id)
          : markMemberInactive(user, id)
        ).then(() => undefined),
      redo: () => restoreMember(user, id).then(() => undefined),
    });
  }
  return updated;
}

export async function removeMember(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can remove church members.");
  }
  const database = await getDatabase();
  const person = await database.get("people", id);
  if (
    !person ||
    person.organizationId !== user.organizationId ||
    person.personType !== "member"
  ) {
    throw new Error("Person not found");
  }
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
  await recordAuditEntry(user, {
    entityType: "member",
    entityId: id,
    action: "removed",
    details: { name: updated.displayName, ...undoAuditDetails() },
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

export async function getOrganizationService(
  organizationId: string,
  serviceId: string,
) {
  const database = await getDatabase();
  const service = await database.get("services", serviceId);
  return service?.organizationId === organizationId && !service.deletedAt
    ? service
    : undefined;
}

export async function saveService(
  user: UserContext,
  input: {
    id?: string;
    serviceDate: string;
    serviceType: ServiceType;
    customName?: string;
    serviceTime?: string;
    notes?: string;
    status: ServiceStatus;
    unnamedVisitorCount?: number;
    sundaySchoolKidsCount?: number;
  },
) {
  const notes = input.notes?.trim() || undefined;
  if (notes && notes.length > 4000) {
    throw new Error("Service notes must be 4,000 characters or fewer.");
  }
  const database = await getDatabase();
  const existing = input.id ? await database.get("services", input.id) : undefined;
  if (existing?.status === "completed") {
    if (input.status === "draft") {
      if (!isAdmin(user)) {
        throw new Error("Only an administrator can reopen a completed service.");
      }
      const organizationSettings = await database.get(
        "organizationSettings",
        user.organizationId,
      );
      if (
        organizationSettings &&
        !organizationSettings.settings.allowAdminReopenCompleted
      ) {
        throw new Error(
          "Reopening completed services is not enabled for this church.",
        );
      }
    } else {
      throw new Error(COMPLETED_SERVICE_LOCK_MESSAGE);
    }
  }
  const timestamp = nowIso();
  const service: ChurchService = {
    id: input.id ?? createId(),
    organizationId: user.organizationId,
    version: existing?.version,
    serviceDate: input.serviceDate,
    serviceType: input.serviceType,
    customName: input.customName?.trim() || undefined,
    serviceTime: input.serviceTime || undefined,
    notes,
    status: input.status,
    unnamedVisitorCount:
      input.unnamedVisitorCount ?? existing?.unnamedVisitorCount ?? 0,
    sundaySchoolKidsCount:
      input.sundaySchoolKidsCount ?? existing?.sundaySchoolKidsCount ?? 0,
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
    payload: serviceCloudRecord(service),
  });
  const serviceAction = !existing
    ? "created"
    : existing.status !== service.status
      ? service.status === "completed"
        ? "completed"
        : "reopened"
      : existing.serviceDate !== service.serviceDate ||
          existing.serviceType !== service.serviceType ||
          existing.customName !== service.customName ||
          existing.serviceTime !== service.serviceTime ||
          existing.notes !== service.notes
        ? "edited"
        : undefined;
  if (serviceAction) {
    await recordAuditEntry(user, {
      entityType: "service",
      entityId: service.id,
      action: serviceAction,
      details: {
        name: service.customName || service.serviceType,
        status: service.status,
        ...undoAuditDetails(),
      },
    });
  }
  announceDataChanged();
  const editableFieldsChanged =
    existing &&
    existing.status === service.status &&
    (existing.serviceDate !== service.serviceDate ||
      existing.serviceType !== service.serviceType ||
      existing.customName !== service.customName ||
      existing.serviceTime !== service.serviceTime ||
      existing.notes !== service.notes);
  if (existing && editableFieldsChanged) {
    const before = {
      serviceDate: existing.serviceDate,
      serviceType: existing.serviceType,
      customName: existing.customName,
      serviceTime: existing.serviceTime,
      notes: existing.notes,
      status: existing.status,
    };
    const after = {
      serviceDate: service.serviceDate,
      serviceType: service.serviceType,
      customName: service.customName,
      serviceTime: service.serviceTime,
      notes: service.notes,
      status: service.status,
    };
    const currentMatches = async (expected: typeof before) => {
      const current = await (await getDatabase()).get("services", service.id);
      return Boolean(
        current &&
          current.organizationId === user.organizationId &&
          !current.deletedAt &&
          current.status !== "completed" &&
          sameValue(current.serviceDate, expected.serviceDate) &&
          sameValue(current.serviceType, expected.serviceType) &&
          sameValue(current.customName, expected.customName) &&
          sameValue(current.serviceTime, expected.serviceTime) &&
          sameValue(current.notes, expected.notes) &&
          sameValue(current.status, expected.status),
      );
    };
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "service",
      entityId: service.id,
      label: `Edit ${service.customName || service.serviceType}`,
      canUndo: () => currentMatches(after),
      canRedo: () => currentMatches(before),
      undo: () => saveService(user, { ...before, id: service.id }).then(() => undefined),
      redo: () => saveService(user, { ...after, id: service.id }).then(() => undefined),
    });
  }
  return service;
}

export async function duplicateService(user: UserContext, sourceId: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can duplicate services.");
  }
  const database = await getDatabase();
  const source = await database.get("services", sourceId);
  if (
    !source ||
    source.deletedAt ||
    source.organizationId !== user.organizationId
  ) {
    throw new Error("Service not found");
  }
  const duplicate = await runWithoutUndoCapture(() =>
    saveService(user, {
      serviceDate: source.serviceDate,
      serviceType: source.serviceType,
      customName: source.customName,
      serviceTime: source.serviceTime,
      notes: source.notes,
      status: "draft",
      unnamedVisitorCount: 0,
      sundaySchoolKidsCount: 0,
    }),
  );
  await recordAuditEntry(user, {
    entityType: "service",
    entityId: duplicate.id,
    action: "duplicated",
    details: {
      name: duplicate.customName || duplicate.serviceType,
      sourceServiceId: source.id,
    },
  });
  const canUndo = async () => {
    const currentDatabase = await getDatabase();
    const [current, attendance, visitors] = await Promise.all([
      currentDatabase.get("services", duplicate.id),
      currentDatabase.getAllFromIndex("attendance", "serviceId", duplicate.id),
      currentDatabase.getAllFromIndex("visitors", "serviceId", duplicate.id),
    ]);
    return Boolean(
      current &&
        !current.deletedAt &&
        current.organizationId === user.organizationId &&
        current.status === "draft" &&
        current.serviceDate === duplicate.serviceDate &&
        current.serviceType === duplicate.serviceType &&
        sameValue(current.customName, duplicate.customName) &&
        current.serviceTime === duplicate.serviceTime &&
        sameValue(current.notes, duplicate.notes) &&
        attendance.length === 0 &&
        visitors.length === 0,
    );
  };
  const canRedo = async () => {
    const current = await (await getDatabase()).get("services", duplicate.id);
    return Boolean(
      current &&
        current.organizationId === user.organizationId &&
        current.deletedAt,
    );
  };
  recordUndoAction({
    id: createId(),
    organizationId: user.organizationId,
    userId: user.userId,
    entityType: "service",
    entityId: duplicate.id,
    label: `Duplicate ${source.customName || source.serviceType}`,
    canUndo,
    canRedo,
    undo: () => removeService(user, duplicate.id).then(() => undefined),
    redo: () => restoreRemovedService(user, duplicate.id).then(() => undefined),
  });
  return duplicate;
}

export async function setUnnamedVisitorCount(
  user: UserContext,
  serviceId: string,
  count: number,
) {
  const database = await getDatabase();
  const service = await requireEditableService(user, serviceId);
  const updated: ChurchService = {
    ...service,
    unnamedVisitorCount: Math.max(0, Math.min(10000, Math.trunc(count))),
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("services", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: updated.id,
    payload: serviceCloudRecord(updated),
  });
  if ((service.unnamedVisitorCount ?? 0) !== updated.unnamedVisitorCount) {
    await recordAuditEntry(user, {
      entityType: "visitor",
      entityId: serviceId,
      action: "unnamed_count_changed",
      details: {
        serviceId,
        from: service.unnamedVisitorCount ?? 0,
        to: updated.unnamedVisitorCount ?? 0,
        ...undoAuditDetails(),
      },
    });
  }
  announceDataChanged();
  const beforeCount = service.unnamedVisitorCount ?? 0;
  const afterCount = updated.unnamedVisitorCount ?? 0;
  if (beforeCount !== afterCount) {
    const currentMatches = async (expected: number) => {
      const current = await (await getDatabase()).get("services", serviceId);
      return Boolean(
        serviceEditable(current) &&
          current?.organizationId === user.organizationId &&
          (current.unnamedVisitorCount ?? 0) === expected,
      );
    };
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "visitor",
      entityId: serviceId,
      label: "Change unnamed visitors",
      canUndo: () => currentMatches(afterCount),
      canRedo: () => currentMatches(beforeCount),
      undo: () => setUnnamedVisitorCount(user, serviceId, beforeCount).then(() => undefined),
      redo: () => setUnnamedVisitorCount(user, serviceId, afterCount).then(() => undefined),
    });
  }
  return updated;
}

export function adjustUnnamedVisitorCount(
  user: UserContext,
  serviceId: string,
  change: number,
) {
  const previous = serviceCountWriteChains.get(serviceId);
  const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(
    async () => {
      const service = await requireEditableService(user, serviceId);
      return setUnnamedVisitorCount(
        user,
        serviceId,
        (service.unnamedVisitorCount ?? 0) + change,
      );
    },
  );
  serviceCountWriteChains.set(serviceId, write);
  const cleanUp = () => {
    if (serviceCountWriteChains.get(serviceId) === write) {
      serviceCountWriteChains.delete(serviceId);
    }
  };
  void write.then(cleanUp, cleanUp);
  return write;
}

export async function setSundaySchoolKidsCount(
  user: UserContext,
  serviceId: string,
  count: number,
) {
  const database = await getDatabase();
  const service = await requireEditableService(user, serviceId);
  const updated: ChurchService = {
    ...service,
    sundaySchoolKidsCount: Math.max(0, Math.min(10000, Math.trunc(count))),
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("services", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: updated.id,
    payload: serviceCloudRecord(updated),
  });
  if (
    (service.sundaySchoolKidsCount ?? 0) !==
    updated.sundaySchoolKidsCount
  ) {
    const program = childProgramForService(service.serviceType);
    await recordAuditEntry(user, {
      entityType: "visitor",
      entityId: serviceId,
      action: "sunday_school_kids_count_changed",
      details: {
        serviceId,
        name: program?.label ?? "Children’s attendance",
        from: service.sundaySchoolKidsCount ?? 0,
        to: updated.sundaySchoolKidsCount ?? 0,
        ...undoAuditDetails(),
      },
    });
  }
  announceDataChanged();
  const beforeCount = service.sundaySchoolKidsCount ?? 0;
  const afterCount = updated.sundaySchoolKidsCount ?? 0;
  if (beforeCount !== afterCount) {
    const currentMatches = async (expected: number) => {
      const current = await (await getDatabase()).get("services", serviceId);
      return Boolean(
        serviceEditable(current) &&
          current?.organizationId === user.organizationId &&
          (current.sundaySchoolKidsCount ?? 0) === expected,
      );
    };
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "visitor",
      entityId: serviceId,
      label: "Change children attendance",
      canUndo: () => currentMatches(afterCount),
      canRedo: () => currentMatches(beforeCount),
      undo: () => setSundaySchoolKidsCount(user, serviceId, beforeCount).then(() => undefined),
      redo: () => setSundaySchoolKidsCount(user, serviceId, afterCount).then(() => undefined),
    });
  }
  return updated;
}

export function adjustSundaySchoolKidsCount(
  user: UserContext,
  serviceId: string,
  change: number,
) {
  const previous = serviceCountWriteChains.get(serviceId);
  const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(
    async () => {
      const service = await requireEditableService(user, serviceId);
      return setSundaySchoolKidsCount(
        user,
        serviceId,
        (service.sundaySchoolKidsCount ?? 0) + change,
      );
    },
  );
  serviceCountWriteChains.set(serviceId, write);
  const cleanUp = () => {
    if (serviceCountWriteChains.get(serviceId) === write) {
      serviceCountWriteChains.delete(serviceId);
    }
  };
  void write.then(cleanUp, cleanUp);
  return write;
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
    payload: serviceCloudRecord(updated),
  });
  await recordAuditEntry(user, {
    entityType: "service",
    entityId: id,
    action: isArchived ? "archived" : "restored",
    details: {
      name: updated.customName || updated.serviceType,
      ...undoAuditDetails(),
    },
  });
  announceDataChanged();
  if (service.isArchived !== isArchived) {
    const currentMatches = async (expected: boolean) => {
      const current = await (await getDatabase()).get("services", id);
      return Boolean(
        current &&
          current.organizationId === user.organizationId &&
          !current.deletedAt &&
          current.isArchived === expected,
      );
    };
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "service",
      entityId: id,
      label: `${isArchived ? "Archive" : "Restore"} ${
        updated.customName || updated.serviceType
      }`,
      canUndo: () => currentMatches(isArchived),
      canRedo: () => currentMatches(service.isArchived),
      undo: () =>
        setServiceArchived(user, id, service.isArchived).then(() => undefined),
      redo: () => setServiceArchived(user, id, isArchived).then(() => undefined),
    });
  }
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
    payload: serviceCloudRecord(updated),
  });
  await recordAuditEntry(user, {
    entityType: "service",
    entityId: id,
    action: "deleted",
    details: { name: updated.customName || updated.serviceType },
  });
  announceDataChanged();
  return updated;
}

async function restoreRemovedService(user: UserContext, id: string) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can restore removed services.");
  }
  const database = await getDatabase();
  const service = await database.get("services", id);
  if (
    !service ||
    !service.deletedAt ||
    service.organizationId !== user.organizationId
  ) {
    throw new Error("Service cannot be restored");
  }
  const updated: ChurchService = {
    ...service,
    isArchived: false,
    deletedAt: null,
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("services", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "services",
    recordId: id,
    payload: serviceCloudRecord(updated),
    basePayload: serviceCloudRecord(service),
  });
  await recordAuditEntry(user, {
    entityType: "service",
    entityId: id,
    action: "restored",
    details: {
      name: updated.customName || updated.serviceType,
      ...undoAuditDetails(),
    },
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
      await requireEditableService(user, serviceId);
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
        basePayload: existing ? toCloudRecord(existing) : undefined,
      });
      const person = await database.get("people", personId);
      if (!existing || existing.present !== present) {
        await recordAuditEntry(user, {
          entityType: "attendance",
          entityId: id,
          action: present ? "marked_present" : "marked_absent",
          details: {
            serviceId,
            personId,
            personName: person?.displayName,
            from: existing?.present ?? false,
            to: present,
            ...undoAuditDetails(),
          },
        });
      }
      announceDataChanged();
      const beforePresent = existing?.present ?? false;
      if (beforePresent !== present) {
        const currentMatches = async (expected: boolean) => {
          const currentDatabase = await getDatabase();
          const [current, service] = await Promise.all([
            currentDatabase.get("attendance", id),
            currentDatabase.get("services", serviceId),
          ]);
          return Boolean(
            current &&
              current.organizationId === user.organizationId &&
              current.present === expected &&
              serviceEditable(service),
          );
        };
        recordUndoAction({
          id: createId(),
          organizationId: user.organizationId,
          userId: user.userId,
          entityType: "attendance",
          entityId: id,
          label: `${present ? "Mark" : "Unmark"} ${
            person?.displayName ?? "member"
          } present`,
          canUndo: () => currentMatches(present),
          canRedo: () => currentMatches(beforePresent),
          undo: () =>
            setMemberAttendance(user, serviceId, personId, beforePresent).then(
              () => undefined,
            ),
          redo: () =>
            setMemberAttendance(user, serviceId, personId, present).then(
              () => undefined,
            ),
        });
      }
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
  await requireEditableService(user, serviceId);
  const timestamp = nowIso();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) {
    throw new Error("A visitor first name is required.");
  }
  let member: Person | undefined;
  if (input.saveAsMember) {
    member = await saveMember(user, { firstName, lastName });
    await runWithoutUndoCapture(() =>
      setMemberAttendance(user, serviceId, member!.id, true),
    );
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
    payload: visitorCloudRecord(visitor),
  });
  await recordAuditEntry(user, {
    entityType: "visitor",
    entityId: visitor.id,
    action: "added",
    details: {
      serviceId,
      name: visitor.displayName,
      notes: visitor.notes,
      ...undoAuditDetails(),
    },
  });
  announceDataChanged();
  const visitorMatches = async (deleted: boolean) => {
    const currentDatabase = await getDatabase();
    const [current, service] = await Promise.all([
      currentDatabase.get("visitors", visitor.id),
      currentDatabase.get("services", serviceId),
    ]);
    return Boolean(
      current &&
        current.organizationId === user.organizationId &&
        Boolean(current.deletedAt) === deleted &&
        sameValue(current.firstName, visitor.firstName) &&
        sameValue(current.lastName, visitor.lastName) &&
        sameValue(current.notes, visitor.notes) &&
        serviceEditable(service),
    );
  };
  recordUndoAction({
    id: createId(),
    organizationId: user.organizationId,
    userId: user.userId,
    entityType: "visitor",
    entityId: visitor.id,
    label: `Add ${visitor.displayName}`,
    canUndo: () => visitorMatches(false),
    canRedo: () => visitorMatches(true),
    undo: () => removeServiceVisitor(user, visitor.id).then(() => undefined),
    redo: () => restoreServiceVisitor(user, visitor.id).then(() => undefined),
  });
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
  await requireEditableService(user, visitor.serviceId);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) {
    throw new Error("A visitor first name is required.");
  }
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
    payload: visitorCloudRecord(updated),
    basePayload: visitorCloudRecord(visitor),
  });
  if (
    visitor.displayName !== updated.displayName ||
    visitor.notes !== updated.notes
  ) {
    await recordAuditEntry(user, {
      entityType: "visitor",
      entityId: updated.id,
      action: "edited",
      details: {
        serviceId: updated.serviceId,
        name: updated.displayName,
        from: {
          name: visitor.displayName,
          notes: visitor.notes,
        },
        to: {
          name: updated.displayName,
          notes: updated.notes,
        },
        ...undoAuditDetails(),
      },
    });
  }
  announceDataChanged();
  if (
    visitor.displayName !== updated.displayName ||
    visitor.notes !== updated.notes
  ) {
    const before = {
      firstName: visitor.firstName,
      lastName: visitor.lastName,
      notes: visitor.notes,
    };
    const after = {
      firstName: updated.firstName,
      lastName: updated.lastName,
      notes: updated.notes,
    };
    const currentMatches = async (expected: typeof before) => {
      const currentDatabase = await getDatabase();
      const [current, service] = await Promise.all([
        currentDatabase.get("visitors", id),
        currentDatabase.get("services", updated.serviceId),
      ]);
      return Boolean(
        current &&
          !current.deletedAt &&
          current.organizationId === user.organizationId &&
          sameValue(current.firstName, expected.firstName) &&
          sameValue(current.lastName, expected.lastName) &&
          sameValue(current.notes, expected.notes) &&
          serviceEditable(service),
      );
    };
    recordUndoAction({
      id: createId(),
      organizationId: user.organizationId,
      userId: user.userId,
      entityType: "visitor",
      entityId: id,
      label: `Edit ${updated.displayName}`,
      canUndo: () => currentMatches(after),
      canRedo: () => currentMatches(before),
      undo: () => editServiceVisitor(user, id, before).then(() => undefined),
      redo: () => editServiceVisitor(user, id, after).then(() => undefined),
    });
  }
  return updated;
}

export async function restoreServiceVisitor(
  user: UserContext,
  id: string,
  restoreLinkedAttendance = true,
) {
  const database = await getDatabase();
  const visitor = await database.get("visitors", id);
  if (
    !visitor ||
    !visitor.deletedAt ||
    visitor.organizationId !== user.organizationId
  ) {
    throw new Error("Visitor cannot be restored");
  }
  await requireEditableService(user, visitor.serviceId);
  const updated: ServiceVisitor = {
    ...visitor,
    deletedAt: null,
    updatedAt: nowIso(),
    updatedBy: user.userId,
  };
  await database.put("visitors", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "service_visitors",
    recordId: updated.id,
    payload: visitorCloudRecord(updated),
    basePayload: visitorCloudRecord(visitor),
  });
  await recordAuditEntry(user, {
    entityType: "visitor",
    entityId: updated.id,
    action: "restored",
    details: {
      serviceId: updated.serviceId,
      name: updated.displayName,
      ...undoAuditDetails(),
    },
  });
  if (restoreLinkedAttendance && updated.memberPersonId) {
    await setMemberAttendance(
      user,
      updated.serviceId,
      updated.memberPersonId,
      true,
    );
  }
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
  await requireEditableService(user, visitor.serviceId);
  const previousLinkedAttendance = visitor.memberPersonId
    ? await database.get(
        "attendance",
        attendanceId(visitor.serviceId, visitor.memberPersonId),
      )
    : undefined;
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
    payload: visitorCloudRecord(updated),
    basePayload: visitorCloudRecord(visitor),
  });
  await recordAuditEntry(user, {
    entityType: "visitor",
    entityId: updated.id,
    action: "removed",
    details: {
      serviceId: visitor.serviceId,
      name: visitor.displayName,
      ...undoAuditDetails(),
    },
  });
  if (visitor.memberPersonId) {
    await runWithoutUndoCapture(() =>
      setMemberAttendance(
        user,
        visitor.serviceId,
        visitor.memberPersonId!,
        false,
      ),
    );
  }
  announceDataChanged();
  const currentMatches = async (deleted: boolean) => {
    const currentDatabase = await getDatabase();
    const [current, service] = await Promise.all([
      currentDatabase.get("visitors", id),
      currentDatabase.get("services", visitor.serviceId),
    ]);
    return Boolean(
      current &&
        current.organizationId === user.organizationId &&
        Boolean(current.deletedAt) === deleted &&
        serviceEditable(service),
    );
  };
  recordUndoAction({
    id: createId(),
    organizationId: user.organizationId,
    userId: user.userId,
    entityType: "visitor",
    entityId: id,
    label: `Remove ${visitor.displayName}`,
    canUndo: () => currentMatches(true),
    canRedo: () => currentMatches(false),
    undo: () =>
      restoreServiceVisitor(
        user,
        id,
        previousLinkedAttendance?.present ?? false,
      ).then(() => undefined),
    redo: () => removeServiceVisitor(user, id).then(() => undefined),
  });
  return updated;
}
