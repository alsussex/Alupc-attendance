import type {
  AttendanceRecord,
  ChurchService,
  ServiceVisitor,
} from "@/lib/domain";
import { namedVisitorChildProgramForService } from "@/lib/services/child-program";

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

export function countNamedChildProgramVisitors(
  visitors: ServiceVisitor[],
  serviceType: string | undefined,
) {
  const program = namedVisitorChildProgramForService(serviceType);
  if (!program) return 0;
  return visitors.filter(
    (visitor) =>
      !visitor.deletedAt &&
      !visitor.savedAsMember &&
      visitor.childProgram === program.kind,
  ).length;
}

export function countVisitors(
  visitors: ServiceVisitor[],
  unnamedVisitorCount = 0,
  serviceType?: string,
) {
  return (
    countNamedVisitors(visitors) -
    countNamedChildProgramVisitors(visitors, serviceType) +
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
  const namedChildProgramCount = countNamedChildProgramVisitors(
    serviceVisitors,
    service.serviceType,
  );
  const unnamedVisitorCount = normalizeUnnamedVisitorCount(
    service.unnamedVisitorCount,
  );
  const visitorTotal =
    namedVisitorCount - namedChildProgramCount + unnamedVisitorCount;
  const sundaySchoolKidsCount = normalizeSundaySchoolKidsCount(
    service.sundaySchoolKidsCount,
  ) + namedChildProgramCount;

  return {
    membersPresent,
    namedVisitorCount: namedVisitorCount - namedChildProgramCount,
    unnamedVisitorCount,
    sundaySchoolKidsCount,
    visitorTotal,
    totalPresent: membersPresent + visitorTotal + sundaySchoolKidsCount,
  };
}
