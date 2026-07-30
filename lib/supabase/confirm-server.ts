import {
  createServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import type { NextRequest } from "next/server";

export type PendingAuthCookie = {
  name: string;
  value: string;
  options: CookieOptions;
};

export function createConfirmationClient(
  request: NextRequest,
  setCookies: (
    cookies: PendingAuthCookie[],
    headers: Record<string, string>,
  ) => void,
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase authentication is not configured.");
  }
  return createServerClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: setCookies,
    },
  });
}
