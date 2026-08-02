"use client";

import Link from "next/link";
import {
  BarChart3,
  CalendarRange,
  ClipboardList,
  Download,
  FileClock,
  Gauge,
  History,
  Printer,
  UsersRound,
  UserRoundSearch,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { useAuth } from "@/components/auth/AuthProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import { AttendanceExportReport } from "@/components/reports/AttendanceExportReport";
import { isAdmin } from "@/lib/auth/permissions";
import type { ReportsDataset, ServiceReportRow } from "@/lib/reports/report-center";
import {
  completedServiceReportRows,
  loadReportsDataset,
  memberAttendanceReport,
  reportCsv,
  reportDashboard,
  reportStatistics,
  visitorReportRows,
  yearlyReport,
} from "@/lib/reports/report-center";
import { formatDate, formatTime } from "@/lib/format/date-time";
import { downloadText } from "@/lib/settings/exports";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

type ReportSection =
  | "dashboard"
  | "monthly"
  | "range"
  | "services"
  | "members"
  | "visitors"
  | "yearly"
  | "statistics"
  | "audit";

interface SectionDefinition {
  id: ReportSection;
  label: string;
  description: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const sections: SectionDefinition[] = [
  { id: "dashboard", label: "Dashboard", description: "Current attendance overview", icon: Gauge },
  { id: "monthly", label: "Monthly Attendance", description: "Official monthly worksheet", icon: ClipboardList },
  { id: "range", label: "Custom Date Range", description: "Any inclusive date range", icon: CalendarRange },
  { id: "services", label: "Service History", description: "Completed services", icon: FileClock },
  { id: "members", label: "Member Attendance", description: "Individual history", icon: UserRoundSearch },
  { id: "visitors", label: "Visitor Report", description: "Named visitor history", icon: UsersRound },
  { id: "yearly", label: "Yearly Summary", description: "Annual church totals", icon: History },
  { id: "statistics", label: "Statistics", description: "Useful attendance records", icon: BarChart3 },
  { id: "audit", label: "Audit Reports", description: "Administrative history", icon: History, adminOnly: true },
];

function serviceName(row: ServiceReportRow) {
  return row.service.customName || row.service.serviceType;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  downloadText(reportCsv(headers, rows), filename, "text/csv");
}

function PrintExportActions({ onExport }: { onExport: () => void }) {
  return (
    <div className="report-actions no-print">
      <button className="button subtle" type="button" onClick={() => window.print()}><Printer aria-hidden="true" /> Print</button>
      <button className="button primary" type="button" onClick={onExport}><Download aria-hidden="true" /> Export spreadsheet</button>
    </div>
  );
}

function ReportMetrics({ values }: { values: Array<{ label: string; value: string | number }> }) {
  return (
    <dl className="report-metrics">
      {values.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DashboardReport({ dataset }: { dataset: ReportsDataset }) {
  const summary = reportDashboard(dataset);
  const metrics = [
    { label: "Active members", value: summary.activeMembers },
    { label: "Archived members", value: summary.archivedMembers },
    { label: "Services this month", value: summary.servicesThisMonth },
    { label: "Attendance this month", value: summary.attendanceThisMonth },
    { label: "Visitors this month", value: summary.visitorsThisMonth },
    { label: "Sunday School Kids", value: summary.sundaySchoolKidsThisMonth },
    { label: "Average Sunday AM", value: summary.averageSundayMorning },
    { label: "Average Sunday PM", value: summary.averageSundayEvening },
    { label: "Average Wednesday", value: summary.averageWednesday },
  ];
  return (
    <section className="report-section print-report">
      <header className="report-section-heading">
        <div><p className="eyebrow">This month</p><h2>Attendance dashboard</h2><p>A concise office overview based on completed services cached on this device.</p></div>
        <PrintExportActions onExport={() => downloadCsv("ALUPC-report-dashboard.csv", ["Metric", "Value"], metrics.map((item) => [item.label, item.value]))} />
      </header>
      <ReportMetrics values={metrics} />
    </section>
  );
}

function ServiceHistoryReport({ dataset }: { dataset: ReportsDataset }) {
  const rows = completedServiceReportRows(dataset);
  const exportRows = rows.map((row) => [row.service.serviceDate, row.service.serviceTime, serviceName(row), row.service.notes, row.members, row.visitors, row.sundaySchoolKids, row.total]);
  return (
    <section className="report-section print-report">
      <header className="report-section-heading"><div><p className="eyebrow">Completed services</p><h2>Service history</h2><p>{rows.length} completed service{rows.length === 1 ? "" : "s"}, including archived history.</p></div><PrintExportActions onExport={() => downloadCsv("ALUPC-service-history.csv", ["Date", "Time", "Service", "Notes", "Members", "Visitors", "Sunday School Kids", "Total"], exportRows)} /></header>
      {rows.length === 0 ? <EmptyState compact icon="□" title="No completed services" message="Completed services will appear here." /> : (
        <div className="report-table-scroll"><table className="report-data-table"><thead><tr><th>Date</th><th>Service</th><th>Notes</th><th>Members</th><th>Visitors</th><th>Sunday School Kids</th><th>Total</th><th className="no-print">Actions</th></tr></thead><tbody>{rows.map((row) => <tr key={row.service.id}><td>{formatDate(row.service.serviceDate)}{row.service.serviceTime ? <small>{formatTime(row.service.serviceTime)}</small> : null}</td><th scope="row">{serviceName(row)}</th><td>{row.service.notes || "—"}</td><td>{row.members}</td><td>{row.visitors}</td><td>{row.sundaySchoolKids}</td><td><strong>{row.total}</strong></td><td className="no-print"><div className="report-row-actions"><Link className="text-link" href={`/services?service=${row.service.id}`}>View</Link><button className="text-button" type="button" onClick={() => downloadCsv(`ALUPC-service-${row.service.serviceDate}-${row.service.id.slice(0, 8)}.csv`, ["Date", "Time", "Service", "Notes", "Members", "Visitors", "Sunday School Kids", "Total"], [[row.service.serviceDate, row.service.serviceTime, serviceName(row), row.service.notes, row.members, row.visitors, row.sundaySchoolKids, row.total]])}>Export</button></div></td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}

function MemberReport({ dataset }: { dataset: ReportsDataset }) {
  const members = useMemo(() => dataset.people.filter((person) => person.personType === "member" && !person.mergedIntoId).sort((a, b) => a.displayName.localeCompare(b.displayName)), [dataset.people]);
  const [query, setQuery] = useState("");
  const [personId, setPersonId] = useState("");
  const matches = members.filter((person) => person.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 20);
  const report = memberAttendanceReport(dataset, personId);
  return (
    <section className="report-section print-report">
      <header className="report-section-heading"><div><p className="eyebrow">Individual attendance</p><h2>Member attendance</h2><p>Search a member to review completed-service attendance.</p></div>{report && <PrintExportActions onExport={() => downloadCsv(`ALUPC-${report.person.displayName.replace(/\W+/g, "-")}-attendance.csv`, ["Date", "Service", "Type", "Time"], report.services.map((row) => [row.service.serviceDate, serviceName(row), row.service.serviceType, row.service.serviceTime]))} />}</header>
      <div className="report-toolbar no-print"><label className="report-member-search">Search member<input type="search" value={query} placeholder="Start typing a name" onChange={(event) => setQuery(event.target.value)} /></label><label>Select member<select value={personId} onChange={(event) => setPersonId(event.target.value)}><option value="">Choose a member</option>{matches.map((person) => <option value={person.id} key={person.id}>{person.displayName}{person.isActive ? "" : " (inactive)"}</option>)}</select></label></div>
      {!report ? <EmptyState compact icon="◎" title="Choose a member" message="Attendance totals and service history will appear here." /> : <>
        <ReportMetrics values={[{ label: "Attendance percentage", value: `${report.percentage}%` }, { label: "Present", value: report.present }, { label: "Absent", value: report.absent }, { label: "First attendance", value: formatDate(report.firstAttendance, "Not yet") }, { label: "Most recent", value: formatDate(report.lastAttendance, "Not yet") }]} />
        <div className="report-table-scroll"><table className="report-data-table"><thead><tr><th>Date</th><th>Service</th><th>Type</th><th className="no-print">Open</th></tr></thead><tbody>{report.services.map((row) => <tr key={row.service.id}><td>{formatDate(row.service.serviceDate)}</td><th scope="row">{serviceName(row)}</th><td>{row.service.serviceType}</td><td className="no-print"><Link className="text-link" href={`/services?service=${row.service.id}`}>View service</Link></td></tr>)}</tbody></table></div>
      </>}
    </section>
  );
}

function VisitorReport({ dataset }: { dataset: ReportsDataset }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rows = useMemo(() => visitorReportRows(dataset, from || undefined, to || undefined), [dataset, from, to]);
  return (
    <section className="report-section print-report">
      <header className="report-section-heading"><div><p className="eyebrow">Named visitors</p><h2>Visitor report</h2><p>Visit frequency and service history for named visitors.</p></div><PrintExportActions onExport={() => downloadCsv("ALUPC-visitor-report.csv", ["Visitor", "Visits", "First visit", "Last visit", "Services"], rows.map((row) => [row.name, row.visits, row.firstVisit, row.lastVisit, row.services.map(serviceName).join("; ")]))} /></header>
      <div className="report-toolbar no-print"><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To<input type="date" min={from || undefined} value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
      {rows.length === 0 ? <EmptyState compact icon="◇" title="No named visitors in this range" message="Change the date range or add named visitors during a service." /> : <div className="report-table-scroll"><table className="report-data-table"><thead><tr><th>Visitor</th><th>Visits</th><th>First visit</th><th>Last visit</th><th>Services attended</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><th scope="row">{row.name}</th><td>{row.visits}</td><td>{formatDate(row.firstVisit)}</td><td>{formatDate(row.lastVisit)}</td><td>{row.services.map((service) => serviceName(service)).join(", ")}</td></tr>)}</tbody></table></div>}
    </section>
  );
}

function YearlySummaryReport({ dataset }: { dataset: ReportsDataset }) {
  const availableYears = [...new Set(dataset.services.filter((service) => !service.deletedAt).map((service) => Number(service.serviceDate.slice(0, 4))))].sort((a, b) => b - a);
  const [year, setYear] = useState(availableYears[0] ?? new Date().getFullYear());
  const summary = yearlyReport(dataset, year);
  const values = [
    { label: "Services held", value: summary.servicesHeld }, { label: "Average Sunday AM", value: summary.averageSundayMorning }, { label: "Average Sunday PM", value: summary.averageSundayEvening }, { label: "Average Wednesday", value: summary.averageWednesday }, { label: "Total visitors", value: summary.totalVisitors }, { label: "Sunday School Kids", value: summary.totalSundaySchoolKids }, { label: "Highest attendance", value: summary.highestAttendance }, { label: "Lowest attendance", value: summary.lowestAttendance }, { label: "Average attendance", value: summary.averageAttendance },
  ];
  return <section className="report-section print-report"><header className="report-section-heading"><div><p className="eyebrow">Annual overview</p><h2>Yearly summary</h2><p>Completed-service totals for the selected year.</p></div><PrintExportActions onExport={() => downloadCsv(`ALUPC-yearly-summary-${year}.csv`, ["Metric", "Value"], values.map((item) => [item.label, item.value]))} /></header><div className="report-toolbar no-print"><label>Year<select value={year} onChange={(event) => setYear(Number(event.target.value))}>{(availableYears.length ? availableYears : [year]).map((item) => <option value={item} key={item}>{item}</option>)}</select></label></div><ReportMetrics values={values} /></section>;
}

function StatisticsReport({ dataset }: { dataset: ReportsDataset }) {
  const stats = reportStatistics(dataset);
  const record = (label: string, row: ServiceReportRow | undefined, value = row?.total ?? 0) => ({ label, value, detail: row ? `${serviceName(row)} · ${formatDate(row.service.serviceDate)}` : "No completed services" });
  const records = [record("Highest attendance ever", stats.highestEver), record("Highest Sunday AM", stats.highestSundayMorning), record("Highest Sunday PM", stats.highestSundayEvening), record("Highest Wednesday", stats.highestWednesday), record("Largest visitor service", stats.largestVisitorService, stats.largestVisitorService?.visitors), record("Largest Sunday School attendance", stats.largestSundaySchool, stats.largestSundaySchool?.sundaySchoolKids), { label: "Average attendance this year", value: stats.averageThisYear, detail: String(new Date().getFullYear()) }, { label: "Average attendance all time", value: stats.averageAllTime, detail: "All completed services" }];
  return <section className="report-section print-report"><header className="report-section-heading"><div><p className="eyebrow">Church records</p><h2>Statistics</h2><p>Useful attendance records without unnecessary charts.</p></div><PrintExportActions onExport={() => downloadCsv("ALUPC-attendance-statistics.csv", ["Statistic", "Value", "Detail"], records.map((item) => [item.label, item.value, item.detail]))} /></header><ol className="report-record-list">{records.map((item) => <li key={item.label}><div><strong>{item.label}</strong><span>{item.detail}</span></div><b>{item.value}</b></li>)}</ol></section>;
}

export function ReportsCenter() {
  const { user } = useAuth();
  const [section, setSection] = useState<ReportSection>(() => {
    if (typeof window === "undefined") return "dashboard";
    const requested = window.location.hash.slice(1) as ReportSection;
    return sections.some((item) => item.id === requested)
      ? requested
      : "dashboard";
  });
  const [dataset, setDataset] = useState<ReportsDataset>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const visibleSections = sections.filter((item) => !item.adminOnly || isAdmin(user));
  const activeSection = visibleSections.some((item) => item.id === section)
    ? section
    : "dashboard";

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      setDataset(await loadReportsDataset(user.organizationId));
      setError("");
    } catch {
      setError("Reports could not be loaded from this device.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refresh());
    return () => { window.clearTimeout(timer); unsubscribe(); };
  }, [refresh]);

  function chooseSection(next: ReportSection) {
    setSection(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  return (
    <div className="reports-page">
      <header className="page-header reports-page-header"><div><p className="eyebrow">Church office</p><h1>Reports</h1><p>View, print, and export accurate attendance information.</p></div><span className="report-data-source">Attendance views work from the synchronized device copy. Official Excel exports verify current Supabase data.</span></header>
      <div className="reports-layout">
        <aside className="reports-navigation no-print" aria-label="Report categories">
          <label className="reports-mobile-selector">Report<select value={activeSection} onChange={(event) => chooseSection(event.target.value as ReportSection)}>{visibleSections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <nav aria-label="Report categories">{visibleSections.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={activeSection === item.id ? "active" : ""} aria-current={activeSection === item.id ? "page" : undefined} onClick={() => chooseSection(item.id)}><Icon aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>; })}</nav>
        </aside>
        <main className="reports-content" aria-live="polite">
          {error && <div className="notice error" role="alert">{error}</div>}
          {loading || !dataset ? <LoadingSkeleton label="Loading reports" rows={6} /> : <>
            {activeSection === "dashboard" && <DashboardReport dataset={dataset} />}
            {activeSection === "monthly" && <AttendanceExportReport mode="monthly" />}
            {activeSection === "range" && <AttendanceExportReport mode="range" />}
            {activeSection === "services" && <ServiceHistoryReport dataset={dataset} />}
            {activeSection === "members" && <MemberReport dataset={dataset} />}
            {activeSection === "visitors" && <VisitorReport dataset={dataset} />}
            {activeSection === "yearly" && <YearlySummaryReport dataset={dataset} />}
            {activeSection === "statistics" && <StatisticsReport dataset={dataset} />}
            {activeSection === "audit" && isAdmin(user) && <section className="report-section print-report"><div className="report-actions no-print"><button className="button subtle" type="button" onClick={() => window.print()}><Printer aria-hidden="true" /> Print</button></div><AuditHistory /></section>}
          </>}
        </main>
      </div>
    </div>
  );
}
