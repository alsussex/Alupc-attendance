"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  installNetworkTelemetryDebug,
  telemetryFetch,
} from "@/lib/network/telemetry";

let client: SupabaseClient | null = null;

export function hasSupabaseConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export function getSupabaseClient() {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  installNetworkTelemetryDebug();
  client = createClient(url, anonKey, {
    global: { fetch: telemetryFetch },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Invitation and recovery routes exchange their own callback credentials
      // so an unrelated existing browser session can never satisfy setup.
      detectSessionInUrl: false,
    },
  });
  return client;
}
