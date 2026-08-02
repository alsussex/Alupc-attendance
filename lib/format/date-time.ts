const dateOptions: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  ...dateOptions,
  hour: "numeric",
  minute: "2-digit",
};

function toDate(value: string) {
  return new Date(value.length === 10 ? `${value}T12:00:00` : value);
}

export function formatDate(value?: string | null, fallback = "Not available") {
  if (!value) return fallback;
  const date = toDate(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleDateString(undefined, dateOptions);
}

export function formatDateTime(
  value?: string | null,
  fallback = "Not available",
) {
  if (!value) return fallback;
  const date = toDate(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString(undefined, dateTimeOptions);
}

export function formatTime(value?: string | null, fallback = "No default") {
  if (!value) return fallback;
  const [hours, minutes] = value.split(":").map(Number);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return fallback;
  }
  return new Date(2026, 0, 1, hours, minutes).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
