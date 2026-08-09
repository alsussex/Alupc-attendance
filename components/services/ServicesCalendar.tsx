"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/feedback/EmptyState";
import type { ChurchService } from "@/lib/domain";
import { formatDate, formatTime } from "@/lib/format/date-time";
import {
  buildServiceCalendar,
  shiftMonthKey,
} from "@/lib/services/calendar";
import type { ServiceDirectoryItem } from "@/lib/services/service-directory";
import { useEscapeKey } from "@/lib/ui/keyboard";

const sundayWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mondayWeekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function ServicesCalendar({
  items,
  currentMonthKey,
  todayKey,
  weekStart = "sunday",
  onOpenService,
}: {
  items: ServiceDirectoryItem[];
  currentMonthKey: string;
  todayKey: string;
  weekStart?: "sunday" | "monday";
  onOpenService: (service: ChurchService) => void | Promise<void>;
}) {
  const [monthKey, setMonthKey] = useState(currentMonthKey);
  const [selectedDate, setSelectedDate] = useState("");
  const days = useMemo(
    () => buildServiceCalendar(items, monthKey, todayKey, weekStart),
    [items, monthKey, todayKey, weekStart],
  );
  const weekdayLabels = weekStart === "monday" ? mondayWeekdays : sundayWeekdays;
  const selectedServices = useMemo(
    () =>
      items
        .filter((item) => item.service.serviceDate === selectedDate)
        .sort(
          (left, right) =>
            (left.service.serviceTime ?? "").localeCompare(
              right.service.serviceTime ?? "",
            ) ||
            serviceTitle(left.service).localeCompare(
              serviceTitle(right.service),
            ),
        ),
    [items, selectedDate],
  );

  useEscapeKey(() => setSelectedDate(""), Boolean(selectedDate));

  return (
    <section className="services-calendar-panel" aria-label="Services calendar">
      <div className="services-calendar-toolbar">
        <div>
          <p className="eyebrow">Monthly schedule</p>
          <h2 aria-live="polite">{monthLabel(monthKey)}</h2>
        </div>
        <div className="services-calendar-navigation">
          <button
            className="button subtle"
            type="button"
            aria-label="Previous month"
            onClick={() =>
              setMonthKey((current) => shiftMonthKey(current, -1))
            }
          >
            ‹
          </button>
          <button
            className="button subtle"
            type="button"
            onClick={() => setMonthKey(currentMonthKey)}
          >
            Today
          </button>
          <label className="calendar-month-picker">
            <span className="sr-only">Choose month and year</span>
            <input
              type="month"
              value={monthKey}
              onChange={(event) => {
                if (event.target.value) setMonthKey(event.target.value);
              }}
            />
          </label>
          <button
            className="button subtle"
            type="button"
            aria-label="Next month"
            onClick={() =>
              setMonthKey((current) => shiftMonthKey(current, 1))
            }
          >
            ›
          </button>
        </div>
      </div>

      <div className="services-calendar" role="grid" aria-label={monthLabel(monthKey)}>
        {weekdayLabels.map((weekday) => (
          <div
            className="services-calendar-weekday"
            role="columnheader"
            key={weekday}
          >
            {weekday}
          </div>
        ))}
        {days.map((day) => {
          const hasServices = day.services.length > 0;
          const content = (
            <>
              <span className="services-calendar-day-number">
                {day.dayNumber}
              </span>
              {hasServices && (
                <span className="services-calendar-day-services">
                  <strong>{day.services.length}</strong>
                  <span>
                    {day.services.length === 1 ? "service" : "services"}
                  </span>
                </span>
              )}
              {day.isToday && (
                <span className="services-calendar-today">Today</span>
              )}
            </>
          );
          const className = [
            "services-calendar-day",
            day.inCurrentMonth ? "" : "outside-month",
            hasServices ? "has-services" : "no-services",
            day.isToday ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div role="gridcell" key={day.dateKey}>
              {hasServices ? (
                <button
                  className={className}
                  type="button"
                  aria-label={`${formatDate(day.dateKey)}, ${day.services.length} ${
                    day.services.length === 1 ? "service" : "services"
                  }`}
                  onClick={() => setSelectedDate(day.dateKey)}
                >
                  {content}
                </button>
              ) : (
                <div className={className} aria-label={formatDate(day.dateKey)}>
                  {content}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {items.length === 0 && (
        <EmptyState
          compact
          icon="□"
          title="No services on the calendar yet"
          message="Create a service and it will appear on its scheduled date."
        />
      )}

      {selectedDate && (
        <div className="modal-backdrop">
          <section
            className="modal calendar-day-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-day-title"
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Services on this date</p>
                <h2 id="calendar-day-title">{formatDate(selectedDate)}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                autoFocus
                aria-label="Close services for this date"
                onClick={() => setSelectedDate("")}
              >
                ×
              </button>
            </div>
            <div className="calendar-day-services">
              {selectedServices.map((item) => (
                <button
                  className="calendar-day-service"
                  type="button"
                  key={item.service.id}
                  onClick={() => {
                    setSelectedDate("");
                    void onOpenService(item.service);
                  }}
                >
                  <span>
                    <strong>{serviceTitle(item.service)}</strong>
                    <small>
                      {item.service.serviceTime
                        ? formatTime(item.service.serviceTime)
                        : "Time not set"}
                    </small>
                  </span>
                  <span>
                    <span className={`status-pill ${item.service.status}`}>
                      {item.service.status === "completed"
                        ? "Completed"
                        : "Draft"}
                    </span>
                    <small>
                      {item.totalPresent} present
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
