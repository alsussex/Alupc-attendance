"use client";

import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";
import type { PullTable, UserContext } from "@/lib/domain";
import { getDatabase } from "@/lib/storage/database";
import { announceDataChanged } from "@/lib/storage/data-events";
import { getSupabaseClient } from "@/lib/supabase/client";

type RemoteChangeListener = (table: PullTable) => void;

interface SharedSubscription {
  channel: RealtimeChannel;
  listeners: Set<RemoteChangeListener>;
  client: SupabaseClient;
}

const subscriptions = new Map<string, SharedSubscription>();
const REMOTE_TABLES = [
  "profiles",
  "people",
  "services",
  "service_attendance",
  "service_visitors",
  "organization_settings",
  "member_private_details",
  "audit_log",
] as const;

export function activeRemoteSubscriptionCount() {
  return subscriptions.size;
}

export function subscribeToRemoteOrganizationChanges(
  user: UserContext,
  listener: RemoteChangeListener,
  client: SupabaseClient = getSupabaseClient(),
) {
  const key = user.organizationId;
  let shared = subscriptions.get(key);

  if (!shared) {
    const listeners = new Set<RemoteChangeListener>();
    let channel = client.channel(`church-sync-${user.organizationId}`);
    const notify = (table: PullTable) => {
      for (const current of listeners) current(table);
    };

    channel = channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "organizations",
        filter: `id=eq.${user.organizationId}`,
      },
      () => notify("organizations"),
    );
    for (const table of REMOTE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: `organization_id=eq.${user.organizationId}`,
        },
        (payload) => {
          if (
            table === "audit_log" &&
            payload.eventType === "DELETE" &&
            typeof payload.old?.id === "string"
          ) {
            void getDatabase().then(async (database) => {
              await database.delete("auditLog", payload.old.id as string);
              announceDataChanged();
            });
          }
          notify(table);
        },
      );
    }
    channel.subscribe();
    shared = { channel, listeners, client };
    subscriptions.set(key, shared);
  }

  shared.listeners.add(listener);
  return () => {
    const current = subscriptions.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    subscriptions.delete(key);
    void current.client.removeChannel(current.channel);
  };
}
