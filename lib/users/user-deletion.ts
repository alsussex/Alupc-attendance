export type UserDeletionMode = "preserve_history" | "delete_history";

export interface DeletableUserProfile {
  id: string;
  organizationId: string;
  role: "admin" | "attendance_taker";
  isActive: boolean;
}

export function validateUserDeletion(input: {
  actorId: string;
  actorOrganizationId: string;
  target: DeletableUserProfile;
  mode: UserDeletionMode;
  confirmation?: string;
  activeAdminCount: number;
}) {
  if (input.target.organizationId !== input.actorOrganizationId) {
    throw new Error("The user was not found in this church organization.");
  }
  if (input.target.id === input.actorId) {
    throw new Error("You cannot delete your currently signed-in account.");
  }
  if (
    input.target.role === "admin" &&
    input.target.isActive &&
    input.activeAdminCount <= 1
  ) {
    throw new Error("The church must keep at least one active administrator.");
  }
  if (
    input.mode === "delete_history" &&
    input.confirmation !== "DELETE"
  ) {
    throw new Error("Type DELETE to permanently remove this user's history.");
  }
}

export function userDeletionMode(value: unknown): UserDeletionMode {
  return value === "delete_history" ? "delete_history" : "preserve_history";
}
