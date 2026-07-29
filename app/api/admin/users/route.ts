import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import {
  authorizeAdministrator,
  validUserRole,
} from "@/lib/supabase/admin-server";

function failure(caught: unknown, status = 400) {
  const message =
    caught instanceof Error ? caught.message : "The request could not be completed.";
  const unauthorized =
    /authentication|session|administrator access/i.test(message);
  return NextResponse.json(
    { error: message },
    { status: unauthorized ? 403 : status },
  );
}

function invitationStatus(user: User) {
  if (user.last_sign_in_at) return "accepted";
  if (user.invited_at) return "pending";
  return "not_invited";
}

async function activeAdminCount(
  admin: Awaited<ReturnType<typeof authorizeAdministrator>>["admin"],
  organizationId: string,
) {
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function GET(request: Request) {
  try {
    const { admin, organizationId } = await authorizeAdministrator(request);
    const [{ data: profiles, error: profileError }, authUsers] =
      await Promise.all([
        admin
          .from("profiles")
          .select("id, display_name, role, is_active, created_at, updated_at")
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true }),
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      ]);
    if (profileError) throw new Error(profileError.message);
    if (authUsers.error) throw new Error(authUsers.error.message);
    const authById = new Map(
      authUsers.data.users.map((user) => [user.id, user]),
    );
    return NextResponse.json({
      users: (profiles ?? []).map((profile) => {
        const authUser = authById.get(profile.id);
        return {
          id: profile.id,
          displayName: profile.display_name || "Authorized user",
          email: authUser?.email ?? "Email unavailable",
          role: profile.role,
          isActive: profile.is_active,
          invitationStatus: authUser
            ? invitationStatus(authUser)
            : "unknown",
          lastSignInAt: authUser?.last_sign_in_at ?? null,
          invitedAt: authUser?.invited_at ?? null,
          createdAt: profile.created_at,
        };
      }),
    });
  } catch (caught) {
    return failure(caught);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, organizationId } = await authorizeAdministrator(request);
    const body = (await request.json()) as {
      email?: unknown;
      displayName?: unknown;
      role?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!email || !email.includes("@")) throw new Error("A valid email is required.");
    if (!displayName) throw new Error("A display name is required.");
    if (!validUserRole(body.role)) throw new Error("A valid role is required.");

    const redirectTo = `${new URL(request.url).origin}/accept-invite`;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { display_name: displayName },
    });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error("Supabase did not create the invited user.");

    const { error: profileError } = await admin.from("profiles").insert({
      id: data.user.id,
      organization_id: organizationId,
      display_name: displayName,
      role: body.role,
      is_active: true,
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      throw new Error(profileError.message);
    }
    return NextResponse.json({ invited: true }, { status: 201 });
  } catch (caught) {
    return failure(caught);
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, organizationId } = await authorizeAdministrator(request);
    const body = (await request.json()) as {
      userId?: unknown;
      action?: unknown;
      role?: unknown;
    };
    const targetId = typeof body.userId === "string" ? body.userId : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!targetId) throw new Error("A target user is required.");
    const { data: target, error: targetError } = await admin
      .from("profiles")
      .select("id, role, is_active")
      .eq("id", targetId)
      .eq("organization_id", organizationId)
      .single();
    if (targetError || !target) throw new Error("The user was not found.");

    const removingActiveAdmin =
      target.role === "admin" &&
      target.is_active &&
      (action === "disable" ||
        (action === "role" && body.role !== "admin"));
    if (removingActiveAdmin && (await activeAdminCount(admin, organizationId)) <= 1) {
      throw new Error("The church must keep at least one active administrator.");
    }

    if (action === "role") {
      if (!validUserRole(body.role)) throw new Error("A valid role is required.");
      const { error } = await admin
        .from("profiles")
        .update({ role: body.role })
        .eq("id", targetId)
        .eq("organization_id", organizationId);
      if (error) throw new Error(error.message);
    } else if (action === "disable") {
      const { error: profileError } = await admin
        .from("profiles")
        .update({ is_active: false })
        .eq("id", targetId)
        .eq("organization_id", organizationId);
      if (profileError) throw new Error(profileError.message);
      const { error: authError } = await admin.auth.admin.updateUserById(
        targetId,
        { ban_duration: "876000h" },
      );
      if (authError) {
        await admin.from("profiles").update({ is_active: true }).eq("id", targetId);
        throw new Error(authError.message);
      }
    } else if (action === "restore") {
      const { error: authError } = await admin.auth.admin.updateUserById(
        targetId,
        { ban_duration: "none" },
      );
      if (authError) throw new Error(authError.message);
      const { error: profileError } = await admin
        .from("profiles")
        .update({ is_active: true })
        .eq("id", targetId)
        .eq("organization_id", organizationId);
      if (profileError) {
        await admin.auth.admin.updateUserById(targetId, {
          ban_duration: "876000h",
        });
        throw new Error(profileError.message);
      }
    } else if (action === "resend") {
      const { data: authUser, error: authUserError } =
        await admin.auth.admin.getUserById(targetId);
      if (authUserError || !authUser.user?.email) {
        throw new Error("The invited email address was not found.");
      }
      if (authUser.user.last_sign_in_at) {
        throw new Error("This user has already accepted the invitation.");
      }
      const { error } = await admin.auth.resend({
        type: "signup",
        email: authUser.user.email,
        options: {
          emailRedirectTo: `${new URL(request.url).origin}/accept-invite`,
        },
      });
      if (error) throw new Error(error.message);
    } else {
      throw new Error("The requested user action is not supported.");
    }

    return NextResponse.json({ updated: true });
  } catch (caught) {
    return failure(caught);
  }
}

export async function DELETE(request: Request) {
  try {
    const { admin, organizationId } = await authorizeAdministrator(request);
    const targetId = new URL(request.url).searchParams.get("userId");
    if (!targetId) throw new Error("A target user is required.");
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id")
      .eq("id", targetId)
      .eq("organization_id", organizationId)
      .single();
    if (profileError || !profile) throw new Error("The user was not found.");
    const { data: authUser, error: authError } =
      await admin.auth.admin.getUserById(targetId);
    if (authError || !authUser.user) throw new Error("The invitation was not found.");
    if (authUser.user.last_sign_in_at) {
      throw new Error("Only a pending invitation can be cancelled.");
    }
    const { error } = await admin.auth.admin.deleteUser(targetId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ cancelled: true });
  } catch (caught) {
    return failure(caught);
  }
}
