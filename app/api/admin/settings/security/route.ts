import { NextResponse } from "next/server";
import { authorizeAdministrator } from "@/lib/supabase/admin-server";

export async function PATCH(request: Request) {
  try {
    const { admin, userId, organizationId } =
      await authorizeAdministrator(request);
    const body = (await request.json()) as { displayName?: unknown };
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName || displayName.length > 120) {
      throw new Error("Display name must contain 1 to 120 characters.");
    }
    const { error: profileError } = await admin
      .from("profiles")
      .update({ display_name: displayName })
      .eq("id", userId)
      .eq("organization_id", organizationId);
    if (profileError) throw new Error(profileError.message);
    const { error: authError } = await admin.auth.admin.updateUserById(userId, {
      user_metadata: { display_name: displayName },
    });
    if (authError) throw new Error(authError.message);
    return NextResponse.json({ updated: true, displayName });
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "The profile could not be updated.";
    const status = /authentication|session|administrator access/i.test(message)
      ? 403
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
