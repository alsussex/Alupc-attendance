export interface NextServiceDefault {
  serviceDate: string;
  serviceTypeId:
    | "sunday-morning"
    | "sunday-evening"
    | "wednesday-bible-study";
  serviceType: string;
  serviceTime: string;
}

const SERVICES = {
  morning: {
    serviceTypeId: "sunday-morning",
    serviceType: "Sunday Morning",
    serviceTime: "10:30",
  },
  evening: {
    serviceTypeId: "sunday-evening",
    serviceType: "Sunday Evening",
    serviceTime: "18:30",
  },
  wednesday: {
    serviceTypeId: "wednesday-bible-study",
    serviceType: "Wednesday Bible Study",
    serviceTime: "19:00",
  },
} as const;

function localDateTime(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    year,
    month,
    day,
    minutes: value("hour") * 60 + value("minute"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function dateAfter(
  date: Pick<ReturnType<typeof localDateTime>, "year" | "month" | "day">,
  days: number,
) {
  const target = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return [
    target.getUTCFullYear(),
    String(target.getUTCMonth() + 1).padStart(2, "0"),
    String(target.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Suggests the next regular ALUPC service using the church's local clock.
 * Sunday Morning remains the suggestion until noon, Sunday Evening until
 * 9 PM, and Wednesday Bible Study until 9 PM Wednesday.
 */
export function nextServiceDefault(
  now = new Date(),
  timeZone = "America/Moncton",
): NextServiceDefault {
  const local = localDateTime(now, timeZone);
  let daysAhead: number;
  let service: (typeof SERVICES)[keyof typeof SERVICES];

  if (local.weekday === 0 && local.minutes < 12 * 60) {
    daysAhead = 0;
    service = SERVICES.morning;
  } else if (local.weekday === 0 && local.minutes < 21 * 60) {
    daysAhead = 0;
    service = SERVICES.evening;
  } else if (local.weekday === 0) {
    daysAhead = 3;
    service = SERVICES.wednesday;
  } else if (local.weekday < 3) {
    daysAhead = 3 - local.weekday;
    service = SERVICES.wednesday;
  } else if (local.weekday === 3 && local.minutes < 21 * 60) {
    daysAhead = 0;
    service = SERVICES.wednesday;
  } else {
    daysAhead = (7 - local.weekday) % 7;
    service = SERVICES.morning;
  }

  return {
    serviceDate: dateAfter(local, daysAhead),
    ...service,
  };
}
