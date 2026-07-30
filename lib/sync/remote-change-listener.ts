"use client";

import type {
  RealtimeChannel,
  SupabaseClient,
} from "@supabase/supabase-js";
import type { UserContext } from "@/lib/domain";
import { getSupabaseClient } from "@/lib/supabase/client";

type RemoteChangeListener = () => void;

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
    const notify = () => {
      for (const current of listeners) current();
    };

    channel = channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "organizations",
        filter: `id=eq.${user.organizationId}`,
      },
      notify,
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
        notify,
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
