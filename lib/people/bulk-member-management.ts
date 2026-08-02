"use client";

import type { UserContext } from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
import {
  listMemberCandidates,
  markMemberInactive,
  restoreMember,
} from "@/lib/repositories/attendance-repository";

export type BulkMemberLifecycleAction = "archive" | "restore";

export interface BulkMemberFailure {
  id: string;
  name: string;
  message: string;
}

export interface BulkMemberLifecycleResult {
  action: BulkMemberLifecycleAction;
  requested: number;
  updated: number;
  skipped: number;
  failed: BulkMemberFailure[];
  updatedIds: string[];
  skippedIds: string[];
}

function safeFailureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "This member could not be updated.";
}

export async function bulkUpdateMemberLifecycle(
  user: UserContext,
  memberIds: Iterable<string>,
  action: BulkMemberLifecycleAction,
): Promise<BulkMemberLifecycleResult> {
  if (!isAdmin(user)) {
    throw new Error("Administrator access is required for bulk member management.");
  }

  const requestedIds = [...new Set(memberIds)];
  const members = await listMemberCandidates(user.organizationId);
  const membersById = new Map(members.map((member) => [member.id, member]));
  const result: BulkMemberLifecycleResult = {
    action,
    requested: requestedIds.length,
    updated: 0,
    skipped: 0,
    failed: [],
    updatedIds: [],
    skippedIds: [],
  };

  for (const id of requestedIds) {
    const member = membersById.get(id);
    if (!member || member.organizationId !== user.organizationId) {
      result.failed.push({
        id,
        name: "Unknown member",
        message: "The member is unavailable or belongs to another organization.",
      });
      continue;
    }

    const alreadyInRequestedState =
      action === "archive"
        ? !member.isActive
        : member.isActive && !member.deletedAt;
    if (alreadyInRequestedState) {
      result.skipped += 1;
      result.skippedIds.push(id);
      continue;
    }

    try {
      if (action === "archive") {
        await markMemberInactive(user, id);
      } else {
        await restoreMember(user, id);
      }
      result.updated += 1;
      result.updatedIds.push(id);
    } catch (error) {
      result.failed.push({
        id,
        name: member.displayName,
        message: safeFailureMessage(error),
      });
    }
  }

  return result;
}
