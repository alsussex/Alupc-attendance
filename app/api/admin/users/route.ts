import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import {
  authorizeAdministrator,
  validUserRole,
} from "@/lib/supabase/admin-server";
import { passwordValidationError } from "@/lib/auth/password";
import type { UserRole } from "@/lib/domain";
import {
  userDeletionMode,
  validateUserDeletion,
} from "@/lib/users/user-deletion";
import { buildUserAuditRecord } from "@/lib/users/user-audit";
import { invitationSetupUrl } from "@/lib/auth/invitation-flow";

function failure(caught: unknown, status = 400) {
  let message =
    caught instanceof Error ? caught.message : "The request could not be completed.";
  if (/already (been )?registered|already exists|duplicate/i.test(message)) {
    message = "An account already exists for this email address.";
  } else if (/password/i.test(message) && /weak|short|characters|strength/i.test(message)) {
    message = "The password does not meet the required security rules.";
  } else if (/service role|supabase administration is not configured/i.test(message)) {
    message = "Secure server-side account administration is not configured.";
  }
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

async function recordUserAudit(
  admin: Awaited<ReturnType<typeof authorizeAdministrator>>["admin"],
  organizationId: string,
  actorId: string,
  entityId: string,
  action: string,
  details: Record<string, unknown>,
  actorSnapshot?: { display_name: string | null; role: UserRole },
) {
  let actor = actorSnapshot;
  if (!actor) {
    const { data, error: actorError } = await admin
      .from("profiles")
      .select("display_name, role")
      .eq("id", actorId)
      .eq("organization_id", organizationId)
      .single();
    if (actorError || !data) throw new Error("The administrator profile was not found.");
    actor = data;
  }
  const id = crypto.randomUUID();
  const { error } = await admin.from("audit_log").insert(
    buildUserAuditRecord({
      id,
      organizationId,
      actorId,
      actorDisplayName: actor.display_name,
      actorRole: actor.role,
      entityId,
      action,
      details,
    }),
  );
  if (error) throw new Error(`User change was applied, but its audit entry failed: ${error.message}`);
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
    const { admin, organizationId, userId } = await authorizeAdministrator(request);
    const body = (await request.json()) as {
      email?: unknown;
      displayName?: unknown;
      role?: unknown;
      mode?: unknown;
      password?: unknown;
    };
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!email || !email.includes("@")) throw new Error("A valid email is required.");
    if (!displayName) throw new Error("A display name is required.");
    if (!validUserRole(body.role)) throw new Error("A valid role is required.");
    const mode = body.mode === "create" ? "create" : "invite";
    const password = typeof body.password === "string" ? body.password : "";
    if (mode === "create") {
      const passwordError = passwordValidationError(password);
      if (passwordError) throw new Error(passwordError);
    }

    const redirectTo = invitationSetupUrl(request.url);
    const { data, error } =
      mode === "create"
        ? await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { display_name: displayName },
          })
        : await admin.auth.admin.inviteUserByEmail(email, {
            redirectTo,
            data: { display_name: displayName },
          });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error("Supabase did not create the user.");

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
    await recordUserAudit(
      admin,
      organizationId,
      userId,
      data.user.id,
      mode === "create" ? "created" : "invited",
      { displayName, email, role: body.role },
    );
    return NextResponse.json(
      mode === "create" ? { created: true } : { invited: true },
      { status: 201 },
    );
  } catch (caught) {
    return failure(caught);
  }
}

export async function PATCH(request: Request) {
  try {
    const { admin, organizationId, userId } = await authorizeAdministrator(request);
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
      .select("id, display_name, role, is_active")
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
    const { data: actorSnapshot, error: actorSnapshotError } = await admin
      .from("profiles")
      .select("display_name, role")
      .eq("id", userId)
      .eq("organization_id", organizationId)
      .single();
    if (actorSnapshotError || !actorSnapshot) {
      throw new Error("The administrator profile was not found.");
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
          emailRedirectTo: invitationSetupUrl(request.url),
        },
      });
      if (error) throw new Error(error.message);
    } else {
      throw new Error("The requested user action is not supported.");
    }

    await recordUserAudit(
      admin,
      organizationId,
      userId,
      targetId,
      action === "role"
        ? "role_changed"
        : action === "disable"
          ? "disabled"
          : action === "restore"
            ? "restored"
            : "invitation_resent",
      {
        targetName: target.display_name || "Authorized user",
        fromRole: target.role,
        toRole: action === "role" ? body.role : target.role,
        fromActive: target.is_active,
        toActive:
          action === "disable"
            ? false
            : action === "restore"
              ? true
          : target.is_active,
      },
      actorSnapshot,
    );

    return NextResponse.json({ updated: true });
  } catch (caught) {
    return failure(caught);
  }
}

export async function DELETE(request: Request) {
  try {
    const { admin, organizationId, userId } = await authorizeAdministrator(request);
    const parameters = new URL(request.url).searchParams;
    const targetId = parameters.get("userId");
    const action = parameters.get("action");
    if (!targetId) throw new Error("A target user is required.");
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id, organization_id, display_name, role, is_active")
      .eq("id", targetId)
      .eq("organization_id", organizationId)
      .single();
    if (profileError || !profile) throw new Error("The user was not found.");

    if (action === "delete") {
      const body = (await request.json().catch(() => ({}))) as {
        mode?: unknown;
        confirmation?: unknown;
      };
      const mode = userDeletionMode(body.mode);
      const confirmation =
        typeof body.confirmation === "string" ? body.confirmation : "";
      const adminCount = await activeAdminCount(admin, organizationId);
      validateUserDeletion({
        actorId: userId,
        actorOrganizationId: organizationId,
        target: {
          id: profile.id,
          organizationId: profile.organization_id,
          role: profile.role,
          isActive: profile.is_active,
        },
        mode,
        confirmation,
        activeAdminCount: adminCount,
      });

      const { data: actorSnapshot, error: actorSnapshotError } = await admin
        .from("profiles")
        .select("display_name, role")
        .eq("id", userId)
        .eq("organization_id", organizationId)
        .single();
      if (actorSnapshotError || !actorSnapshot) {
        throw new Error("The administrator profile was not found.");
      }

      const { error: authDeleteError } = await admin.auth.admin.deleteUser(
        targetId,
        false,
      );
      if (authDeleteError) throw new Error(authDeleteError.message);

      // profiles.id cascades from auth.users. This scoped delete is an
      // idempotent safeguard for projects applying the migration to older data.
      const { error: profileDeleteError } = await admin
        .from("profiles")
        .delete()
        .eq("id", targetId)
        .eq("organization_id", organizationId);
      if (profileDeleteError) throw new Error(profileDeleteError.message);

      if (mode === "delete_history") {
        const { error: historyDeleteError } = await admin.rpc(
          "purge_user_audit_history",
          {
            p_organization_id: organizationId,
            p_user_id: targetId,
          },
        );
        if (historyDeleteError) {
          throw new Error(
            `The account was deleted, but its audit-history cleanup failed: ${historyDeleteError.message}`,
          );
        }
      }

      await recordUserAudit(
        admin,
        organizationId,
        userId,
        targetId,
        "deleted",
        {
          targetName: profile.display_name || "Authorized user",
          targetRole: profile.role,
          historyDeleted: mode === "delete_history",
        },
        actorSnapshot,
      );

      return NextResponse.json({
        deleted: true,
        historyDeleted: mode === "delete_history",
      });
    }

    const { data: authUser, error: authError } =
      await admin.auth.admin.getUserById(targetId);
    if (authError || !authUser.user) throw new Error("The invitation was not found.");
    if (authUser.user.last_sign_in_at) {
      throw new Error("Only a pending invitation can be cancelled.");
    }
    const { error } = await admin.auth.admin.deleteUser(targetId);
    if (error) throw new Error(error.message);
    await recordUserAudit(
      admin,
      organizationId,
      userId,
      targetId,
      "invitation_cancelled",
      { targetName: profile.display_name || "Authorized user" },
    );
    return NextResponse.json({ cancelled: true });
  } catch (caught) {
    return failure(caught);
  }
}
