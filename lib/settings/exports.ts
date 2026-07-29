"use client";

import type { UserContext } from "@/lib/domain";
import { isAdmin } from "@/lib/auth/permissions";
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
  const [organization, settings, profiles, people, services, attendance, visitors] =
    await Promise.all([
      database.get("organizations", organizationId),
      database.get("organizationSettings", organizationId),
      database.getAllFromIndex("profiles", "organizationId", organizationId),
      database.getAllFromIndex("people", "organizationId", organizationId),
      database.getAllFromIndex("services", "organizationId", organizationId),
      database.getAllFromIndex("attendance", "organizationId", organizationId),
      database.getAllFromIndex("visitors", "organizationId", organizationId),
    ]);

  if (dataset === "backup") {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        organization,
        settings,
        profiles,
        people,
        services,
        attendance,
        visitors,
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
      ["ID", "First name", "Last name", "Display name", "Status", "Created"],
      records.map((person) => [
        person.id,
        person.firstName,
        person.lastName,
        person.displayName,
        person.isActive ? "Active" : "Inactive",
        person.createdAt,
      ]),
    );
  }

  if (dataset === "services") {
    return rowsToCsv(
      ["ID", "Date", "Time", "Type", "Custom name", "Status"],
      services
        .filter((service) => !service.deletedAt)
        .map((service) => [
          service.id,
          service.serviceDate,
          service.serviceTime,
          service.serviceType,
          service.customName,
          service.status,
        ]),
    );
  }

  if (dataset === "attendance") {
    return rowsToCsv(
      ["ID", "Service ID", "Person ID", "Present", "Updated"],
      attendance.map((record) => [
        record.id,
        record.serviceId,
        record.personId,
        record.present,
        record.updatedAt,
      ]),
    );
  }

  return rowsToCsv(
    ["ID", "Service ID", "First name", "Last name", "Notes", "Saved as member"],
    visitors
      .filter((visitor) => !visitor.deletedAt)
      .map((visitor) => [
        visitor.id,
        visitor.serviceId,
        visitor.firstName,
        visitor.lastName,
        visitor.notes,
        visitor.savedAsMember,
      ]),
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
