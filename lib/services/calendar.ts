import type { ServiceDirectoryItem } from "@/lib/services/service-directory";

export interface ServiceCalendarDay {
  dateKey: string;
  dayNumber: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  services: ServiceDirectoryItem[];
}

function parseMonthKey(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return { year, month };
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function shiftMonthKey(monthKey: string, amount: number) {
  const { year, month } = parseMonthKey(monthKey);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return shifted.toISOString().slice(0, 7);
}

export function buildServiceCalendar(
  items: ServiceDirectoryItem[],
  monthKey: string,
  todayKey: string,
  weekStart: "sunday" | "monday" = "sunday",
) {
  const { year, month } = parseMonthKey(monthKey);
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const calendarStart = new Date(firstDay);
  const firstWeekday = firstDay.getUTCDay();
  const leadingDays =
    weekStart === "monday" ? (firstWeekday + 6) % 7 : firstWeekday;
  calendarStart.setUTCDate(1 - leadingDays);

  const servicesByDate = new Map<string, ServiceDirectoryItem[]>();
  for (const item of items) {
    const existing = servicesByDate.get(item.service.serviceDate) ?? [];
    existing.push(item);
    servicesByDate.set(item.service.serviceDate, existing);
  }
  for (const services of servicesByDate.values()) {
    services.sort(
      (left, right) =>
        (left.service.serviceTime ?? "").localeCompare(
          right.service.serviceTime ?? "",
        ) ||
        (left.service.customName || left.service.serviceType).localeCompare(
          right.service.customName || right.service.serviceType,
        ),
    );
  }

  return Array.from({ length: 42 }, (_, index): ServiceCalendarDay => {
    const date = new Date(calendarStart);
    date.setUTCDate(calendarStart.getUTCDate() + index);
    const key = dateKey(date);
    return {
      dateKey: key,
      dayNumber: date.getUTCDate(),
      inCurrentMonth:
        date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month,
      isToday: key === todayKey,
      services: servicesByDate.get(key) ?? [],
    };
  });
}
