import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/lib/domain";

interface AdminAuthorization {
  admin: SupabaseClient;
  userId: string;
  organizationId: string;
}

function serverSettings() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error("Server-side Supabase administration is not configured.");
  }
  return { url, anonKey, serviceRoleKey };
}

export function validUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "attendance_taker";
}

export async function authorizeAdministrator(
  request: Request,
): Promise<AdminAuthorization> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Authentication is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const { url, anonKey, serviceRoleKey } = serverSettings();
  const verifier = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userError,
  } = await verifier.auth.getUser(token);
  if (userError || !user) throw new Error("Your session is not valid.");

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("organization_id, role, is_active")
    .eq("id", user.id)
    .single();
  if (
    profileError ||
    !profile?.is_active ||
    profile.role !== "admin" ||
    !profile.organization_id
  ) {
    throw new Error("Administrator access is required.");
  }
  return {
    admin,
    userId: user.id,
    organizationId: profile.organization_id,
  };
}
