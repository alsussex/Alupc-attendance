import type { UserContext, UserRole } from "@/lib/domain";

export function isAdmin(
  user: Pick<UserContext, "role"> | null | undefined,
) {
  return user?.role === "admin";
}

export function canManageUsers(role: UserRole) {
  return role === "admin";
}

export function canArchiveRecords(role: UserRole) {
  return role === "admin";
}

export function canAddMembers(role: UserRole) {
  return role === "admin" || role === "attendance_taker";
}

export function canReopenCompletedServices(
  user: Pick<UserContext, "role" | "canReopenCompletedServices"> | null | undefined,
) {
  return user?.role === "admin" || user?.canReopenCompletedServices === true;
}
