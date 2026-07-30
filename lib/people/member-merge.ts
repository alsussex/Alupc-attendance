"use client";

import {
  attendanceId,
  nowIso,
  type AttendanceRecord,
  type MemberPrivateDetails,
  type Person,
  type UserContext,
} from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
import { recordAuditEntry } from "@/lib/audit/audit-repository";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { enqueueChange } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";

export interface MemberMergePreview {
  survivor: Person;
  duplicate: Person;
  attendanceToMove: number;
  overlappingServices: number;
  visitorLinksToMove: number;
  auditEntriesPreserved: number;
  mergedEmail?: string;
  mergedPhone?: string;
  alternateContacts: string[];
  notesOutcome: "none" | "survivor" | "duplicate" | "combined";
}

function oldestFirst(left: Person, right: Person) {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function mergedNotes(
  survivorNotes: string,
  duplicateName: string,
  duplicateNotes: string,
) {
  const left = survivorNotes.trim();
  const right = duplicateNotes.trim();
  if (!left) return right;
  if (!right || left === right) return left;
  return `${left}\n\n— Merged from ${duplicateName} —\n${right}`.slice(0, 4000);
}

async function requireMergePair(
  user: UserContext,
  firstId: string,
  secondId: string,
) {
  if (!isAdmin(user)) {
    throw new Error("Only an administrator can merge members.");
  }
  if (firstId === secondId) throw new Error("Choose two different members.");
  const database = await getDatabase();
  const [first, second] = await Promise.all([
    database.get("people", firstId),
    database.get("people", secondId),
  ]);
  if (
    !first ||
    !second ||
    first.organizationId !== user.organizationId ||
    second.organizationId !== user.organizationId ||
    first.personType !== "member" ||
    second.personType !== "member" ||
    first.mergedIntoId ||
    second.mergedIntoId
  ) {
    throw new Error("Both members must belong to your church.");
  }
  return [first, second].sort(oldestFirst) as [Person, Person];
}

export async function previewMemberMerge(
  user: UserContext,
  firstId: string,
  secondId: string,
): Promise<MemberMergePreview> {
  const [survivor, duplicate] = await requireMergePair(
    user,
    firstId,
    secondId,
  );
  const database = await getDatabase();
  const [attendance, visitors, audits, survivorDetails, duplicateDetails] =
    await Promise.all([
      database.getAllFromIndex(
        "attendance",
        "organizationId",
        user.organizationId,
      ),
      database.getAllFromIndex(
        "visitors",
        "organizationId",
        user.organizationId,
      ),
      database.getAllFromIndex(
        "auditLog",
        "organizationId",
        user.organizationId,
      ),
      database.get("memberPrivateDetails", survivor.id),
      database.get("memberPrivateDetails", duplicate.id),
    ]);
  const survivorServices = new Set(
    attendance
      .filter((entry) => entry.personId === survivor.id && entry.present)
      .map((entry) => entry.serviceId),
  );
  const duplicateAttendance = attendance.filter(
    (entry) => entry.personId === duplicate.id && entry.present,
  );
  const survivorNotes = survivorDetails?.notes.trim() ?? "";
  const duplicateNotes = duplicateDetails?.notes.trim() ?? "";
  return {
    survivor,
    duplicate,
    attendanceToMove: duplicateAttendance.length,
    overlappingServices: duplicateAttendance.filter((entry) =>
      survivorServices.has(entry.serviceId),
    ).length,
    visitorLinksToMove: visitors.filter(
      (visitor) => visitor.memberPersonId === duplicate.id,
    ).length,
    auditEntriesPreserved: audits.filter(
      (entry) =>
        entry.entityId === duplicate.id ||
        entry.details?.personId === duplicate.id ||
        entry.details?.memberPersonId === duplicate.id,
    ).length,
    mergedEmail: survivor.email || duplicate.email,
    mergedPhone: survivor.phone || duplicate.phone,
    alternateContacts: [
      ...(survivor.email &&
      duplicate.email &&
      survivor.email !== duplicate.email
        ? [`Email: ${duplicate.email}`]
        : []),
      ...(survivor.phone &&
      duplicate.phone &&
      survivor.phone !== duplicate.phone
        ? [`Phone: ${duplicate.phone}`]
        : []),
    ],
    notesOutcome:
      survivorNotes && duplicateNotes && survivorNotes !== duplicateNotes
        ? "combined"
        : survivorNotes
          ? "survivor"
          : duplicateNotes
            ? "duplicate"
            : "none",
  };
}

async function queueRecord(
  table:
    | "people"
    | "member_private_details"
    | "service_attendance"
    | "service_visitors",
  record: Person | MemberPrivateDetails | AttendanceRecord | Record<string, unknown>,
  base?: object,
) {
  const cloud = toCloudRecord(record);
  await enqueueChange({
    organizationId: String(cloud.organization_id),
    table,
    recordId: String(cloud.id),
    payload: cloud,
    basePayload: base ? toCloudRecord(base) : undefined,
  });
}

export async function mergeMembers(
  user: UserContext,
  firstId: string,
  secondId: string,
) {
  const preview = await previewMemberMerge(user, firstId, secondId);
  const { survivor, duplicate } = preview;
  const database = await getDatabase();
  const timestamp = nowIso();
  const [attendance, visitors, survivorDetails, duplicateDetails] =
    await Promise.all([
      database.getAllFromIndex(
        "attendance",
        "organizationId",
        user.organizationId,
      ),
      database.getAllFromIndex(
        "visitors",
        "organizationId",
        user.organizationId,
      ),
      database.get("memberPrivateDetails", survivor.id),
      database.get("memberPrivateDetails", duplicate.id),
    ]);

  const updatedSurvivor: Person = {
    ...survivor,
    email: survivor.email || duplicate.email,
    phone: survivor.phone || duplicate.phone,
    isActive: survivor.isActive || duplicate.isActive,
    inactiveAt:
      survivor.isActive || duplicate.isActive ? null : survivor.inactiveAt,
    restoredAt: survivor.restoredAt || duplicate.restoredAt,
    deletedAt: null,
    mergedFromIds: [
      ...new Set([
        ...(survivor.mergedFromIds ?? []),
        duplicate.id,
        ...(duplicate.mergedFromIds ?? []),
      ]),
    ],
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
  await database.put("people", updatedSurvivor);
  await queueRecord("people", updatedSurvivor, survivor);

  const updatedDuplicate: Person = {
    ...duplicate,
    isActive: false,
    inactiveAt: duplicate.inactiveAt ?? timestamp,
    deletedAt: timestamp,
    mergedIntoId: survivor.id,
    updatedAt: timestamp,
    updatedBy: user.userId,
  };
  await database.put("people", updatedDuplicate);
  await queueRecord("people", updatedDuplicate, duplicate);

  const baseNotes = mergedNotes(
    survivorDetails?.notes ?? "",
    duplicate.displayName,
    duplicateDetails?.notes ?? "",
  );
  const notes = [
    baseNotes,
    ...(preview.alternateContacts.length
      ? [
          `— Additional contact from ${duplicate.displayName} —\n${preview.alternateContacts.join("\n")}`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4000);
  if (notes || survivorDetails || duplicateDetails) {
    const details: MemberPrivateDetails = {
      id: survivor.id,
      memberId: survivor.id,
      organizationId: user.organizationId,
      version: survivorDetails?.version,
      notes,
      createdAt: survivorDetails?.createdAt ?? duplicateDetails?.createdAt ?? timestamp,
      updatedAt: timestamp,
      createdBy: survivorDetails?.createdBy ?? user.userId,
      updatedBy: user.userId,
    };
    await database.put("memberPrivateDetails", details);
    await queueRecord("member_private_details", details, survivorDetails);
  }

  const targetAttendance = new Map(
    attendance
      .filter((entry) => entry.personId === survivor.id)
      .map((entry) => [entry.serviceId, entry]),
  );
  for (const source of attendance.filter(
    (entry) => entry.personId === duplicate.id,
  )) {
    const existingTarget = targetAttendance.get(source.serviceId);
    if (source.present || existingTarget) {
      const target: AttendanceRecord = existingTarget
        ? {
            ...existingTarget,
            present: existingTarget.present || source.present,
            updatedAt: timestamp,
            updatedBy: user.userId,
          }
        : {
            ...source,
            id: attendanceId(source.serviceId, survivor.id),
            personId: survivor.id,
            version: undefined,
            createdAt: timestamp,
            createdBy: user.userId,
            updatedAt: timestamp,
            updatedBy: user.userId,
          };
      await database.put("attendance", target);
      await queueRecord("service_attendance", target, existingTarget);
      targetAttendance.set(source.serviceId, target);
    }
    if (source.present) {
      const cleared = {
        ...source,
        present: false,
        updatedAt: timestamp,
        updatedBy: user.userId,
      };
      await database.put("attendance", cleared);
      await queueRecord("service_attendance", cleared, source);
    }
  }

  for (const visitor of visitors.filter(
    (entry) => entry.memberPersonId === duplicate.id,
  )) {
    const updated = {
      ...visitor,
      memberPersonId: survivor.id,
      updatedAt: timestamp,
      updatedBy: user.userId,
    };
    await database.put("visitors", updated);
    await queueRecord("service_visitors", updated, visitor);
  }

  await recordAuditEntry(user, {
    entityType: "member",
    entityId: survivor.id,
    action: "merged",
    details: {
      name: survivor.displayName,
      mergedSourceId: duplicate.id,
      mergedSourceName: duplicate.displayName,
      attendanceMoved: preview.attendanceToMove,
      visitorLinksMoved: preview.visitorLinksToMove,
      notesChanged: preview.notesOutcome !== "none",
    },
  });
  await recordAuditEntry(user, {
    entityType: "member",
    entityId: duplicate.id,
    action: "merged_into",
    details: {
      name: duplicate.displayName,
      targetId: survivor.id,
      targetName: survivor.displayName,
    },
  });
  announceDataChanged();
  return { survivor: updatedSurvivor, duplicate: updatedDuplicate };
}
