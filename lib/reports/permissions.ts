import type { UserContext, UserRole } from "@/lib/domain";

export type ReportSectionId =
  | "dashboard"
  | "monthly"
  | "range"
  | "services"
  | "members"
  | "visitors"
  | "snapshots"
  | "yearly"
  | "statistics"
  | "audit";

const attendanceTakerSections = new Set<ReportSectionId>([
  "monthly",
  "range",
  "services",
  "members",
  "visitors",
  "snapshots",
]);

export function canAccessReportSection(
  role: UserRole,
  section: ReportSectionId,
) {
  return role === "admin" || attendanceTakerSections.has(section);
}

export function assertReportSectionAccess(
  user: UserContext,
  section: ReportSectionId,
) {
  if (!canAccessReportSection(user.role, section)) {
    throw new Error("Administrator access is required for this report.");
  }
}

export function defaultReportSection(role: UserRole): ReportSectionId {
  return role === "admin" ? "dashboard" : "monthly";
}
