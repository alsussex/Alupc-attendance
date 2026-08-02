"use client";

import type { UserContext } from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
import { buildAttendanceReportRows } from "@/lib/reports/attendance-report";
import { getDatabase } from "@/lib/storage/database";

export type ExportDataset =
  | "members"
  | "inactive-members"
  | "services"
  | "attendance"
  | "visitors";

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function rowsToCsv(
  headers: string[],
  rows: Array<Array<unknown>>,
) {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n");
}

export async function buildOrganizationExport(
  user: UserContext,
  dataset: ExportDataset | "backup",
) {
  if (!isAdmin(user)) throw new Error("Administrator access is required.");
  const database = await getDatabase();
  const organizationId = user.organizationId;
  const [organization, settings, profiles, people, memberPrivateDetails, services, attendance, visitors, auditLog] =
    await Promise.all([
      database.get("organizations", organizationId),
      database.get("organizationSettings", organizationId),
      database.getAllFromIndex("profiles", "organizationId", organizationId),
      database.getAllFromIndex("people", "organizationId", organizationId),
      database.getAllFromIndex(
        "memberPrivateDetails",
        "organizationId",
        organizationId,
      ),
      database.getAllFromIndex("services", "organizationId", organizationId),
      database.getAllFromIndex("attendance", "organizationId", organizationId),
      database.getAllFromIndex("visitors", "organizationId", organizationId),
      database.getAllFromIndex("auditLog", "organizationId", organizationId),
    ]);
  const reportRows = buildAttendanceReportRows(
    services,
    attendance,
    visitors,
  );
  const serviceSummaries = new Map(
    reportRows.map((summary) => [summary.serviceId, summary]),
  );

  if (dataset === "backup") {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        organization,
        settings,
        profiles,
        people,
        memberPrivateDetails,
        services,
        attendance,
        visitors,
        auditLog,
        serviceAttendanceSummaries: services.map((service) => {
          const summary = serviceSummaries.get(service.id)!;
          return {
            service_id: service.id,
            members_present: summary.membersPresent,
            named_visitor_count: summary.namedVisitorCount,
            unnamed_visitor_count: summary.unnamedVisitorCount,
            sunday_school_kids_count: summary.sundaySchoolKidsCount,
            visitor_total: summary.visitorTotal,
            total_present: summary.totalPresent,
          };
        }),
      },
      null,
      2,
    );
  }

  if (dataset === "members" || dataset === "inactive-members") {
    const active = dataset === "members";
    const records = people.filter(
      (person) =>
        person.personType === "member" &&
        !person.deletedAt &&
        person.isActive === active,
    );
    return rowsToCsv(
      [
        "ID",
        "First name",
        "Last name",
        "Display name",
        "Email",
        "Phone",
        "Administrative notes",
        "Status",
        "Created",
      ],
      records.map((person) => [
        person.id,
        person.firstName,
        person.lastName,
        person.displayName,
        person.email,
        person.phone,
        memberPrivateDetails.find((details) => details.memberId === person.id)
          ?.notes,
        person.isActive ? "Active" : "Inactive",
        person.createdAt,
      ]),
    );
  }

  if (dataset === "services") {
    return rowsToCsv(
      [
        "ID",
        "Date",
        "Time",
        "Type",
        "Custom name",
        "Notes",
        "Status",
        "members_present",
        "named_visitor_count",
        "unnamed_visitor_count",
        "sunday_school_kids_count",
        "visitor_total",
        "total_present",
      ],
      services.filter((service) => !service.deletedAt).map((service) => {
        const summary = serviceSummaries.get(service.id)!;
        return [
          service.id,
          service.serviceDate,
          service.serviceTime,
          service.serviceType,
          service.customName,
          service.notes,
          service.status,
          summary.membersPresent,
          summary.namedVisitorCount,
          summary.unnamedVisitorCount,
          summary.sundaySchoolKidsCount,
          summary.visitorTotal,
          summary.totalPresent,
        ];
      }),
    );
  }

  if (dataset === "attendance") {
    return rowsToCsv(
      [
        "ID",
        "Service ID",
        "Person ID",
        "Present",
        "Updated",
        "members_present",
        "named_visitor_count",
        "unnamed_visitor_count",
        "sunday_school_kids_count",
        "visitor_total",
        "total_present",
      ],
      attendance.map((record) => {
        const summary = serviceSummaries.get(record.serviceId);
        return [
          record.id,
          record.serviceId,
          record.personId,
          record.present,
          record.updatedAt,
          summary?.membersPresent ?? 0,
          summary?.namedVisitorCount ?? 0,
          summary?.unnamedVisitorCount ?? 0,
          summary?.sundaySchoolKidsCount ?? 0,
          summary?.visitorTotal ?? 0,
          summary?.totalPresent ?? 0,
        ];
      }),
    );
  }

  return rowsToCsv(
    [
      "ID",
      "Service ID",
      "First name",
      "Last name",
      "Notes",
      "Saved as member",
      "members_present",
      "named_visitor_count",
      "unnamed_visitor_count",
      "sunday_school_kids_count",
      "visitor_total",
      "total_present",
    ],
    visitors
      .filter((visitor) => !visitor.deletedAt)
      .map((visitor) => {
        const summary = serviceSummaries.get(visitor.serviceId);
        return [
          visitor.id,
          visitor.serviceId,
          visitor.firstName,
          visitor.lastName,
          visitor.notes,
          visitor.savedAsMember,
          summary?.membersPresent ?? 0,
          summary?.namedVisitorCount ?? 0,
          summary?.unnamedVisitorCount ?? 0,
          summary?.sundaySchoolKidsCount ?? 0,
          summary?.visitorTotal ?? 0,
          summary?.totalPresent ?? 0,
        ];
      }),
  );
}

export function downloadText(
  content: string,
  filename: string,
  contentType: string,
) {
  const url = URL.createObjectURL(
    new Blob([content], { type: `${contentType};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
