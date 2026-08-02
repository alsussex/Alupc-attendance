import type {
  AttendanceRecord,
  ChurchService,
  ServiceVisitor,
} from "@/lib/domain";

export interface ServiceAttendanceSummary {
  membersPresent: number;
  namedVisitorCount: number;
  unnamedVisitorCount: number;
  sundaySchoolKidsCount: number;
  visitorTotal: number;
  totalPresent: number;
}

export function normalizeUnnamedVisitorCount(value: number | undefined) {
  return Math.max(0, Math.trunc(value ?? 0));
}

export function normalizeSundaySchoolKidsCount(value: number | undefined) {
  return Math.max(0, Math.trunc(value ?? 0));
}

export function countNamedVisitors(visitors: ServiceVisitor[]) {
  return visitors.filter(
    (visitor) => !visitor.deletedAt && !visitor.savedAsMember,
  ).length;
}

export function countVisitors(
  visitors: ServiceVisitor[],
  unnamedVisitorCount = 0,
) {
  return (
    countNamedVisitors(visitors) +
    normalizeUnnamedVisitorCount(unnamedVisitorCount)
  );
}

export function summarizeServiceAttendance(
  service: ChurchService,
  attendance: AttendanceRecord[],
  visitors: ServiceVisitor[],
): ServiceAttendanceSummary {
  const serviceAttendance = attendance.filter(
    (record) => record.serviceId === service.id && record.present,
  );
  const serviceVisitors = visitors.filter(
    (visitor) => visitor.serviceId === service.id,
  );
  const membersPresent = new Set(
    serviceAttendance.map((record) => record.personId),
  ).size;
  const namedVisitorCount = countNamedVisitors(serviceVisitors);
  const unnamedVisitorCount = normalizeUnnamedVisitorCount(
    service.unnamedVisitorCount,
  );
  const visitorTotal = namedVisitorCount + unnamedVisitorCount;
  const sundaySchoolKidsCount = normalizeSundaySchoolKidsCount(
    service.sundaySchoolKidsCount,
  );

  return {
    membersPresent,
    namedVisitorCount,
    unnamedVisitorCount,
    sundaySchoolKidsCount,
    visitorTotal,
    totalPresent: membersPresent + visitorTotal + sundaySchoolKidsCount,
  };
}
