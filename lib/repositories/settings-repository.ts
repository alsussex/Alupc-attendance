"use client";

import {
  nowIso,
  type ApplicationSettings,
  type Organization,
  type OrganizationSettings,
  type UserContext,
} from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { enqueueChange } from "@/lib/sync/queue";
import { toCloudRecord } from "@/lib/sync/serialization";
import {
  defaultApplicationSettings,
  mergeApplicationSettings,
  validateApplicationSettings,
} from "@/lib/settings/settings";

export async function getOrganization(organizationId: string) {
  return (await getDatabase()).get("organizations", organizationId);
}

export async function getOrganizationSettings(
  organizationId: string,
): Promise<OrganizationSettings> {
  const database = await getDatabase();
  const existing = await database.get("organizationSettings", organizationId);
  if (existing) {
    return {
      ...existing,
      settings: mergeApplicationSettings(existing.settings),
    };
  }
  const timestamp = nowIso();
  return {
    id: organizationId,
    organizationId,
    settings: defaultApplicationSettings(),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "",
    updatedBy: "",
  };
}

export async function saveOrganizationSettings(
  user: UserContext,
  settings: ApplicationSettings,
) {
  if (!isAdmin(user)) throw new Error("Administrator access is required.");
  const errors = validateApplicationSettings(settings);
  if (errors.length) throw new Error(errors[0]);
  const database = await getDatabase();
  const existing = await database.get(
    "organizationSettings",
    user.organizationId,
  );
  const timestamp = nowIso();
  const record: OrganizationSettings = {
    id: user.organizationId,
    organizationId: user.organizationId,
    settings: mergeApplicationSettings(settings),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy: existing?.createdBy || user.userId,
    updatedBy: user.userId,
  };
  await database.put("organizationSettings", record);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "organization_settings",
    recordId: record.id,
    payload: toCloudRecord(record),
  });
  announceDataChanged();
  return record;
}

export async function saveOrganizationIdentity(
  user: UserContext,
  input: { name: string; slug: string },
) {
  if (!isAdmin(user)) throw new Error("Administrator access is required.");
  const name = input.name.trim();
  const slug = input.slug.trim().toLocaleLowerCase();
  if (name.length < 2 || name.length > 120) {
    throw new Error("Church name must contain 2 to 120 characters.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      "Church slug may contain lowercase letters, numbers, and single hyphens.",
    );
  }
  const database = await getDatabase();
  const existing = await database.get("organizations", user.organizationId);
  if (!existing) throw new Error("Organization data is not available.");
  const updated: Organization = {
    ...existing,
    name,
    slug,
    updatedAt: nowIso(),
  };
  await database.put("organizations", updated);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "organizations",
    recordId: updated.id,
    payload: toCloudRecord(updated),
  });
  announceDataChanged();
  return updated;
}
