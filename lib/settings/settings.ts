import {
  DEFAULT_APPLICATION_SETTINGS,
  type ApplicationSettings,
  type Person,
} from "@/lib/domain";

export function defaultApplicationSettings(): ApplicationSettings {
  return structuredClone(DEFAULT_APPLICATION_SETTINGS);
}

export function mergeApplicationSettings(
  value?: Partial<ApplicationSettings> | null,
): ApplicationSettings {
  const defaults = defaultApplicationSettings();
  return {
    ...defaults,
    ...value,
    serviceTypes:
      Array.isArray(value?.serviceTypes) && value.serviceTypes.length > 0
        ? value.serviceTypes
        : defaults.serviceTypes,
  };
}

export function validateApplicationSettings(settings: ApplicationSettings) {
  const errors: string[] = [];
  if (!settings.shortName.trim() || settings.shortName.trim().length > 30) {
    errors.push("Church short name must contain 1 to 30 characters.");
  }
  if (!settings.timezone.trim()) errors.push("A default timezone is required.");
  if (!settings.visitorLabel.trim() || settings.visitorLabel.length > 40) {
    errors.push("Visitor label must contain 1 to 40 characters.");
  }
  const names = settings.serviceTypes.map((item) =>
    item.name.trim().toLocaleLowerCase(),
  );
  if (names.some((name) => !name)) {
    errors.push("Every service type needs a name.");
  }
  if (new Set(names).size !== names.length) {
    errors.push("Service type names must be unique.");
  }
  if (
    settings.serviceTypes.some(
      (item) =>
        item.defaultTime &&
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.defaultTime),
    )
  ) {
    errors.push("Default service times must use a valid 24-hour time.");
  }
  return errors;
}

export function sortAttendanceMembers(
  members: Person[],
  sort: ApplicationSettings["attendanceSort"],
) {
  return [...members].sort((left, right) => {
    if (sort === "recently_added") {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        left.displayName.localeCompare(right.displayName)
      );
    }
    const leftValue =
      sort === "last_name" ? left.lastName : left.firstName;
    const rightValue =
      sort === "last_name" ? right.lastName : right.firstName;
    return (
      leftValue.localeCompare(rightValue) ||
      left.lastName.localeCompare(right.lastName) ||
      left.firstName.localeCompare(right.firstName)
    );
  });
}

export function effectiveServiceTypeName(
  settings: ApplicationSettings,
  id: string,
) {
  return settings.serviceTypes.find((item) => item.id === id)?.name;
}

export function formatChurchDate(
  date: string,
  settings: Pick<ApplicationSettings, "dateFormat" | "timezone">,
  options?: Intl.DateTimeFormatOptions,
) {
  if (settings.dateFormat === "iso" && !options) return date;
  const defaultOptions: Intl.DateTimeFormatOptions =
    settings.dateFormat === "day_month_year"
      ? { day: "numeric", month: "long", year: "numeric" }
      : { month: "long", day: "numeric", year: "numeric" };
  return new Intl.DateTimeFormat(undefined, {
    ...(options ?? defaultOptions),
    timeZone: settings.timezone,
  }).format(new Date(`${date}T12:00:00Z`));
}
