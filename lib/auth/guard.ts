import type { UserContext } from "@/lib/domain";

export const PROTECTED_ROUTES = [
  "/dashboard",
  "/people",
  "/services",
  "/settings",
] as const;

export function canAccessProtectedRoute(user: UserContext | null) {
  return user !== null;
}
