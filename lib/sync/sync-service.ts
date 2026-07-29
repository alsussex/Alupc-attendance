"use client";

import { getSupabaseClient, hasSupabaseConfig } from "@/lib/supabase/client";
import { getDatabase } from "@/lib/storage/database";

let activeSync: Promise<void> | null = null;

export function syncPendingChanges() {
  if (activeSync) return activeSync;
  activeSync = runSync().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync() {
  if (
    typeof navigator === "undefined" ||
    !navigator.onLine ||
    !hasSupabaseConfig()
  ) {
    return;
  }

  const database = await getDatabase();
  const supabase = getSupabaseClient();
  const queue = await database.getAll("syncQueue");

  for (const item of queue) {
    await database.put("syncQueue", {
      ...item,
      status: "processing",
      attempts: item.attempts + 1,
      updatedAt: new Date().toISOString(),
    });

    const { error } = await supabase.from(item.table).upsert(item.payload, {
      onConflict:
        item.table === "service_attendance"
          ? "organization_id,service_id,person_id"
          : "id",
    });

    if (error) {
      await database.put("syncQueue", {
        ...item,
        status: "error",
        attempts: item.attempts + 1,
        lastError: error.message,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    await database.delete("syncQueue", item.id);
  }
}

export function registerAutomaticSync(onSettled?: () => void) {
  const handler = () => {
    void syncPendingChanges().finally(onSettled);
  };
  window.addEventListener("online", handler);
  return () => window.removeEventListener("online", handler);
}
