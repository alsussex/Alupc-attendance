import type {
  AttendanceRecord,
  ChurchService,
  ServiceVisitor,
} from "@/lib/domain";
import { summarizeServiceAttendance } from "@/lib/services/attendance-summary";

export interface AttendanceReportRow {
  serviceId: string;
  serviceDate: string;
  serviceName: string;
  status: ChurchService["status"];
  membersPresent: number;
  namedVisitorCount: number;
  unnamedVisitorCount: number;
  sundaySchoolKidsCount: number;
  visitorTotal: number;
  totalPresent: number;
}

export function buildAttendanceReportRows(
  services: ChurchService[],
  attendance: AttendanceRecord[],
  visitors: ServiceVisitor[],
): AttendanceReportRow[] {
  return services
    .filter((service) => !service.deletedAt)
    .map((service) => {
      const summary = summarizeServiceAttendance(
        service,
        attendance,
        visitors,
      );
      return {
        serviceId: service.id,
        serviceDate: service.serviceDate,
        serviceName: service.customName || service.serviceType,
        status: service.status,
        ...summary,
      };
    })
    .sort(
      (left, right) =>
        right.serviceDate.localeCompare(left.serviceDate) ||
        left.serviceName.localeCompare(right.serviceName),
    );
}
