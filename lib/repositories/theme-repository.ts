"use client";

import {
  nowIso,
  type Profile,
  type ThemePreference,
  type UserContext,
} from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { enqueueChange } from "@/lib/sync/queue";

export async function saveThemePreference(
  user: UserContext,
  themePreference: ThemePreference,
) {
  const database = await getDatabase();
  const existing = await database.get("profiles", user.userId);
  const timestamp = nowIso();
  const profile: Profile = existing
    ? { ...existing, themePreference, updatedAt: timestamp }
    : {
        id: user.userId,
        organizationId: user.organizationId,
        role: user.role,
        isActive: true,
        themePreference,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
  await database.put("profiles", profile);
  await enqueueChange({
    organizationId: user.organizationId,
    table: "profiles",
    recordId: user.userId,
    payload: {
      id: user.userId,
      organization_id: user.organizationId,
      theme_preference: themePreference,
    },
  });
  announceDataChanged();
  return profile;
}

export async function loadThemePreference(user: UserContext) {
  const database = await getDatabase();
  const queued = (
    await database.getAllFromIndex("syncQueue", "recordId", user.userId)
  ).some((item) => item.table === "profiles");
  if (queued) return undefined;
  return (await database.get("profiles", user.userId))?.themePreference;
}
