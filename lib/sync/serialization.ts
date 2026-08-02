import type {
  AttendanceRecord,
  AuditLogEntry,
  ChurchService,
  Organization,
  OrganizationSettings,
  MemberPrivateDetails,
  Person,
  Profile,
  PullTable,
  ServiceVisitor,
} from "@/lib/domain";

export type LocalPullRecord =
  | Organization
  | OrganizationSettings
  | MemberPrivateDetails
  | Profile
  | Person
  | ChurchService
  | AttendanceRecord
  | ServiceVisitor
  | AuditLogEntry;

export function toCloudRecord<T extends object>(value: T) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        entry,
      ]),
  );
}

function requiredString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Cloud record is missing ${key}.`);
  }
  return value;
}

function optionalString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "string" && value ? value : undefined;
}

function stringOrEmpty(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function requiredBoolean(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new Error(`Cloud record is missing ${key}.`);
  }
  return value;
}

function optionalBoolean(row: Record<string, unknown>, key: string) {
  return typeof row[key] === "boolean" ? row[key] : false;
}

function optionalStringArray(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function auditFields(row: Record<string, unknown>) {
  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    version:
      typeof row.version === "number" ? row.version : undefined,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    createdBy: requiredString(row, "created_by"),
    updatedBy: requiredString(row, "updated_by"),
  };
}

export function fromCloudRecord(
  table: PullTable,
  row: Record<string, unknown>,
): LocalPullRecord {
  if (table === "organizations") {
    return {
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      slug: requiredString(row, "slug"),
      version:
        typeof row.version === "number" ? row.version : undefined,
      createdBy: optionalString(row, "created_by"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  if (table === "profiles") {
    const role = requiredString(row, "role");
    if (role !== "admin" && role !== "attendance_taker") {
      throw new Error("Cloud profile has an unsupported role.");
    }
    const themePreference = optionalString(row, "theme_preference");
    return {
      id: requiredString(row, "id"),
      organizationId: requiredString(row, "organization_id"),
      displayName: optionalString(row, "display_name"),
      role,
      isActive: requiredBoolean(row, "is_active"),
      themePreference:
        themePreference === "light" ||
        themePreference === "dark" ||
        themePreference === "system"
          ? themePreference
          : "system",
      version: typeof row.version === "number" ? row.version : undefined,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  if (table === "audit_log") {
    const role = requiredString(row, "role");
    const entityType = requiredString(row, "entity_type");
    const details = row.details;
    return {
      id: requiredString(row, "id"),
      organizationId: requiredString(row, "organization_id"),
      entityType: entityType as AuditLogEntry["entityType"],
      entityId: requiredString(row, "entity_id"),
      action: requiredString(row, "action"),
      userId: requiredString(row, "user_id"),
      userDisplayName: requiredString(row, "user_display_name"),
      role: role === "admin" ? "admin" : "attendance_taker",
      occurredAt: requiredString(row, "occurred_at"),
      deviceId: optionalString(row, "device_id"),
      details:
        details && typeof details === "object" && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : undefined,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    };
  }

  const audited = auditFields(row);
  if (table === "organization_settings") {
    const settings = row.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Cloud organization settings are invalid.");
    }
    return {
      ...audited,
      settings: settings as OrganizationSettings["settings"],
    };
  }
  if (table === "people") {
    const personType = requiredString(row, "person_type");
    if (personType !== "member" && personType !== "visitor") {
      throw new Error("Cloud person has an unsupported type.");
    }
    return {
      ...audited,
      firstName: requiredString(row, "first_name"),
      lastName: requiredString(row, "last_name"),
      displayName: requiredString(row, "display_name"),
      personType,
      isActive: requiredBoolean(row, "is_active"),
      duplicateNameAllowed: optionalBoolean(
        row,
        "duplicate_name_allowed",
      ),
      email: optionalString(row, "email"),
      phone: optionalString(row, "phone"),
      inactiveAt: optionalString(row, "inactive_at"),
      restoredAt: optionalString(row, "restored_at"),
      deletedAt: optionalString(row, "deleted_at"),
      mergedIntoId: optionalString(row, "merged_into_id"),
      mergedFromIds: optionalStringArray(row, "merged_from_ids"),
    };
  }

  if (table === "member_private_details") {
    return {
      ...audited,
      memberId: requiredString(row, "member_id"),
      notes: stringOrEmpty(row, "notes"),
    };
  }

  if (table === "services") {
    return {
      ...audited,
      serviceDate: requiredString(row, "service_date"),
      serviceType: requiredString(row, "service_type") as ChurchService["serviceType"],
      customName: optionalString(row, "custom_name"),
      serviceTime: optionalString(row, "service_time")?.slice(0, 5),
      notes: optionalString(row, "notes"),
      status: requiredString(row, "status") as ChurchService["status"],
      unnamedVisitorCount:
        typeof row.unnamed_visitor_count === "number"
          ? row.unnamed_visitor_count
          : 0,
      sundaySchoolKidsCount:
        typeof row.sunday_school_kids_count === "number"
          ? row.sunday_school_kids_count
          : 0,
      isArchived: optionalBoolean(row, "is_archived"),
      deletedAt: optionalString(row, "deleted_at"),
    };
  }

  if (table === "service_attendance") {
    return {
      ...audited,
      serviceId: requiredString(row, "service_id"),
      personId: requiredString(row, "person_id"),
      present: requiredBoolean(row, "present"),
    };
  }

  return {
    ...audited,
    serviceId: requiredString(row, "service_id"),
    firstName: requiredString(row, "first_name"),
    lastName: stringOrEmpty(row, "last_name"),
    displayName: requiredString(row, "display_name"),
    savedAsMember: requiredBoolean(row, "saved_as_member"),
    memberPersonId: optionalString(row, "member_person_id"),
    notes: optionalString(row, "notes"),
    deletedAt: optionalString(row, "deleted_at"),
  };
}
