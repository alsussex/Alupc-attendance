"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useSynchronization } from "@/components/sync/SyncProvider";
import { UserManagement } from "@/components/users/UserManagement";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { LoadingSkeleton } from "@/components/feedback/LoadingSkeleton";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import { ArchivedServicesManager } from "@/components/settings/ArchivedServicesManager";
import { MonthlyAttendanceExport } from "@/components/settings/MonthlyAttendanceExport";
import {
  type ApplicationSettings,
  type Organization,
  type ServiceTypeSetting,
  type SyncQueueItem,
} from "@/lib/domain";
import {
  getOrganization,
  getOrganizationSettings,
  saveOrganizationIdentity,
  saveOrganizationSettings,
} from "@/lib/repositories/settings-repository";
import {
  buildOrganizationExport,
  downloadText,
  type ExportDataset,
} from "@/lib/settings/exports";
import { validateApplicationSettings } from "@/lib/settings/settings";
import { getDatabase, clearLocalDatabase } from "@/lib/storage/database";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getStoredSyncStatus } from "@/lib/sync/sync-service";
import { formatDateTime, formatTime } from "@/lib/format/date-time";
import { isAdmin } from "@/lib/auth/permissions";
import {
  getAttendanceExperiencePreferences,
  getServerAttendanceExperiencePreferences,
  saveAttendanceExperiencePreferences,
  subscribeToAttendanceExperiencePreferences,
  type AttendanceExperiencePreferences,
} from "@/lib/settings/attendance-preferences";
import {
  humanReadableSyncError,
  syncDiagnosticDetails,
} from "@/lib/sync/errors";

type SettingsSection =
  | "overview"
  | "personal"
  | "general"
  | "services"
  | "attendance"
  | "visitors"
  | "users"
  | "audit"
  | "data"
  | "sync"
  | "security";

const sectionDefinitions: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: "overview", label: "Overview", description: "Church and application status" },
  { id: "personal", label: "Personal", description: "Appearance and attendance experience" },
  { id: "general", label: "General", description: "Name, location, and dates" },
  { id: "services", label: "Services", description: "Types, times, and workflow" },
  { id: "attendance", label: "Attendance", description: "Lists, totals, and completion" },
  { id: "visitors", label: "Visitors", description: "Names, notes, and totals" },
  { id: "users", label: "Users", description: "Invitations and permissions" },
  { id: "audit", label: "Audit History", description: "Accountability and change history" },
  { id: "data", label: "Data & Export", description: "CSV and organization backup" },
  { id: "sync", label: "Device & Sync", description: "This device and saved changes" },
  { id: "security", label: "Security", description: "Profile, password, and sessions" },
];

const attendanceTakerSectionIds: SettingsSection[] = [
  "personal",
  "sync",
  "security",
];

const adminSectionIds = sectionDefinitions.map((section) => section.id);

export function settingsSectionIdsForRole(role?: string) {
  return role === "admin" ? adminSectionIds : attendanceTakerSectionIds;
}

function initialSection(): SettingsSection {
  if (typeof window === "undefined") return "overview";
  const requested = new URLSearchParams(window.location.search).get("section");
  return sectionDefinitions.some((section) => section.id === requested)
    ? (requested as SettingsSection)
    : "overview";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function SettingsCenter() {
  const { user, session, signOut, refreshAccess } = useAuth();
  const synchronization = useSynchronization();
  const { showToast } = useToast();
  const confirmAction = useConfirmation();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [settings, setSettings] = useState<ApplicationSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();
  const [storedSyncError, setStoredSyncError] = useState<string>();
  const [syncDiagnostics, setSyncDiagnostics] = useState<SyncQueueItem[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const [offlineReady, setOfflineReady] = useState(
    () =>
      typeof navigator !== "undefined" &&
      Boolean(navigator.serviceWorker?.controller),
  );
  const pendingCount = synchronization.pendingCount;
  const admin = isAdmin(user);
  const visibleSectionIds = settingsSectionIdsForRole(user?.role);
  const visibleSections = sectionDefinitions.filter((item) =>
    visibleSectionIds.includes(item.id),
  );
  const activeSection = visibleSectionIds.includes(section)
    ? section
    : admin
      ? "overview"
      : "personal";
  const attendancePreferences = useSyncExternalStore(
    subscribeToAttendanceExperiencePreferences,
    getAttendanceExperiencePreferences,
    getServerAttendanceExperiencePreferences,
  );

  const refreshDeviceStatus = useCallback(async () => {
    if (!user) return;
    const database = await getDatabase();
    const [status, queue] = await Promise.all([
      getStoredSyncStatus(user.organizationId, user.userId),
      database.getAllFromIndex(
        "syncQueue",
        "organizationId",
        user.organizationId,
      ),
    ]);
    setLastSuccessfulSync(status?.lastSuccessfulSyncAt);
    setStoredSyncError(status?.lastError);
    setSyncDiagnostics(
      queue
        .filter(
          (item) => item.status === "error" || item.status === "conflict",
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    const database = await getDatabase();
    const [nextOrganization, settingsRecord, nextProfile] = await Promise.all([
      getOrganization(user.organizationId),
      getOrganizationSettings(user.organizationId),
      database.get("profiles", user.userId),
    ]);
    setOrganization(nextOrganization ?? null);
    setName(nextOrganization?.name ?? "Abundant Life UPC");
    setSlug(nextOrganization?.slug ?? "abundant-life-upc");
    setSettings(settingsRecord.settings);
    setSavedSnapshot(JSON.stringify(settingsRecord.settings));
    setDisplayName(nextProfile?.displayName ?? user.displayName ?? "");
    await refreshDeviceStatus();
  }, [refreshDeviceStatus, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const onPopState = () => setSection(initialSection());
    const updateConnection = () => setOnline(navigator.onLine);
    const updateOfflineReady = () =>
      setOfflineReady(Boolean(navigator.serviceWorker?.controller));
    window.addEventListener("popstate", onPopState);
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      updateOfflineReady,
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        updateOfflineReady,
      );
    };
  }, [load]);

  useEffect(() => {
    if (synchronization.isSyncing) return;
    const timer = window.setTimeout(() => void refreshDeviceStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [
    pendingCount,
    refreshDeviceStatus,
    synchronization.error,
    synchronization.isSyncing,
    synchronization.phase,
  ]);

  const dirty =
    Boolean(settings) &&
    (JSON.stringify(settings) !== savedSnapshot ||
      name !== (organization?.name ?? "Abundant Life UPC") ||
      slug !== (organization?.slug ?? "abundant-life-upc"));

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function openSection(next: SettingsSection) {
    if (!visibleSectionIds.includes(next)) return;
    if (
      dirty &&
      !(await confirmAction({
        title: "Leave without saving?",
        message:
          "You have unsaved settings changes. Leaving this section will discard them.",
        confirmLabel: "Leave section",
        tone: "danger",
      }))
    ) {
      return;
    }
    setSection(next);
    setFeedback("");
    setError("");
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("section");
    else url.searchParams.set("section", next);
    window.history.pushState({}, "", url);
  }

  async function saveChanges(includeIdentity = false) {
    if (!user || !settings || saving) return;
    setSaving(true);
    setFeedback(online ? "Saving…" : "Saving locally…");
    setError("");
    try {
      const validationError = validateApplicationSettings(settings)[0];
      if (validationError) throw new Error(validationError);
      if (
        includeIdentity &&
        (name.trim().length < 2 || name.trim().length > 120)
      ) {
        throw new Error("Church name must contain 2 to 120 characters.");
      }
      if (
        includeIdentity &&
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim())
      ) {
        throw new Error(
          "Church slug may contain lowercase letters, numbers, and single hyphens.",
        );
      }
      let nextOrganization = organization;
      if (includeIdentity) {
        nextOrganization = await saveOrganizationIdentity(user, { name, slug });
      }
      const record = await saveOrganizationSettings(user, settings);
      setOrganization(nextOrganization);
      setName(nextOrganization?.name ?? name);
      setSlug(nextOrganization?.slug ?? slug);
      setSettings(record.settings);
      setSavedSnapshot(JSON.stringify(record.settings));
      if (!online) {
        setFeedback("Saved on this device. Changes will sync automatically.");
      } else {
        const outcome = await synchronization.syncNow();
        setFeedback(
          outcome.status === "synced"
            ? "Saved"
            : "Saved on this device. Changes will sync automatically.",
        );
      }
      await refreshDeviceStatus();
      showToast("Settings saved.", { key: `settings-saved:${activeSection}` });
    } catch (caught) {
      setFeedback("");
      setError(
        caught instanceof Error ? caught.message : "Settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function exportData(dataset: ExportDataset | "backup") {
    if (!user) return;
    const content = await buildOrganizationExport(user, dataset);
    const prefix = (settings?.shortName || "alupc")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const base =
      dataset === "backup"
        ? `${prefix}-backup-${today()}.json`
        : `${prefix}-${dataset}-${today()}.csv`;
    downloadText(
      content,
      base,
      dataset === "backup" ? "application/json" : "text/csv",
    );
    showToast("Export completed.", { key: `export:${dataset}:${today()}` });
  }

  async function runSecurityAction(action: () => Promise<void>) {
    setError("");
    try {
      await action();
    } catch (caught) {
      setFeedback("");
      setError(
        caught instanceof Error
          ? caught.message
          : "The security action could not be completed.",
      );
    }
  }

  if (!settings) {
    return (
      <section className="settings-loading">
        <LoadingSkeleton label="Loading settings" rows={5} />
      </section>
    );
  }

  return (
    <div className="settings-page product-page settings-product-page">
      <div className="page-heading">
        <p className="eyebrow">{admin ? "Administration" : "Your preferences"}</p>
        <h1>Settings</h1>
        <p>
          {admin
            ? "Manage church-wide configuration and your personal experience."
            : "Adjust this device, review synchronization, and manage your account."}
        </p>
      </div>
      <div className="settings-layout">
        <aside className="settings-navigation">
          <label className="settings-mobile-selector">
            <span>Settings section</span>
            <select
              value={activeSection}
              onChange={(event) =>
                openSection(event.target.value as SettingsSection)
              }
            >
              {visibleSections.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <nav aria-label="Settings sections">
            {visibleSections.map((item) => (
              <button
                className={activeSection === item.id ? "active" : ""}
                type="button"
                key={item.id}
                aria-current={activeSection === item.id ? "page" : undefined}
                onClick={() => openSection(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-content">
          {feedback && (
            <div className="notice success" role="status">
              {feedback}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}

          {activeSection === "overview" && admin && (
            <SettingsOverview
              organization={organization}
              userEmail={user?.email ?? ""}
              pendingCount={pendingCount}
              syncLabel={
                synchronization.isSyncing
                  ? "Syncing"
                  : synchronization.phase === "error"
                    ? "Sync issue"
                    : online
                      ? "Online"
                      : "Offline"
              }
              openSection={openSection}
            />
          )}
          {activeSection === "personal" && (
            <PersonalSettingsSection
              preferences={attendancePreferences}
              onChange={saveAttendanceExperiencePreferences}
            />
          )}
          {activeSection === "general" && admin && (
            <SettingsSectionCard
              eyebrow="Organization"
              title="General settings"
              description="Church identity and regional defaults used throughout the application."
              onSave={() => void saveChanges(true)}
              saving={saving}
            >
              <div className="form-grid">
                <label>
                  Church name
                  <input
                    value={name}
                    maxLength={120}
                    required
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label>
                  Church short name
                  <input
                    value={settings.shortName}
                    maxLength={30}
                    required
                    onChange={(event) =>
                      setSettings({ ...settings, shortName: event.target.value })
                    }
                  />
                </label>
                <label>
                  Church slug
                  <input
                    value={slug}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    required
                    onChange={(event) => setSlug(event.target.value)}
                  />
                  <small>Lowercase letters, numbers, and hyphens.</small>
                </label>
                <label>
                  Default timezone
                  <select
                    value={settings.timezone}
                    onChange={(event) =>
                      setSettings({ ...settings, timezone: event.target.value })
                    }
                  >
                    <option>America/Moncton</option>
                    <option>America/Halifax</option>
                    <option>America/Toronto</option>
                    <option>UTC</option>
                  </select>
                </label>
                <label>
                  Date format
                  <select
                    value={settings.dateFormat}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        dateFormat: event.target
                          .value as ApplicationSettings["dateFormat"],
                      })
                    }
                  >
                    <option value="month_day_year">Month Day, Year</option>
                    <option value="day_month_year">Day Month Year</option>
                    <option value="iso">YYYY-MM-DD</option>
                  </select>
                </label>
                <label>
                  Week starts
                  <select
                    value={settings.weekStart}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        weekStart: event.target
                          .value as ApplicationSettings["weekStart"],
                      })
                    }
                  >
                    <option value="sunday">Sunday</option>
                    <option value="monday">Monday</option>
                  </select>
                </label>
              </div>
            </SettingsSectionCard>
          )}
          {activeSection === "services" && admin && (
            <>
              <ServiceSettings
                settings={settings}
                onChange={setSettings}
                onSave={() => void saveChanges()}
                saving={saving}
              />
              <ArchivedServicesManager />
            </>
          )}
          {activeSection === "attendance" && admin && (
            <SettingsSectionCard
              eyebrow="Attendance workflow"
              title="Attendance settings"
              description="Checked always means Present; unchecked always means Absent."
              onSave={() => void saveChanges()}
              saving={saving}
            >
              <div className="settings-readonly">
                <strong>Default interpretation</strong>
                <span>Checked = Present · Unchecked = Absent</span>
              </div>
              <label>
                Attendance list sorting
                <select
                  value={settings.attendanceSort}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      attendanceSort: event.target
                        .value as ApplicationSettings["attendanceSort"],
                    })
                  }
                >
                  <option value="first_name">First name</option>
                  <option value="last_name">Last name</option>
                  <option value="recently_added">Recently added</option>
                </select>
              </label>
              <SettingsToggleList
                settings={settings}
                onChange={setSettings}
                items={[
                  ["showAttendanceTotals", "Show attendance totals", "Display the running summary while taking attendance."],
                  ["warnZeroAttendance", "Warn before zero-attendance completion", "Ask for confirmation before completing an empty service."],
                  ["showInactiveInAttendance", "Show inactive members", "Include inactive members in new attendance checklists."],
                ]}
              />
            </SettingsSectionCard>
          )}
          {activeSection === "visitors" && admin && (
            <SettingsSectionCard
              eyebrow="Service visitors"
              title="Visitor settings"
              description="Visitor entries remain service-specific unless explicitly saved as members."
              onSave={() => void saveChanges()}
              saving={saving}
            >
              <label>
                Default visitor label
                <input
                  value={settings.visitorLabel}
                  maxLength={40}
                  onChange={(event) =>
                    setSettings({ ...settings, visitorLabel: event.target.value })
                  }
                />
              </label>
              <SettingsToggleList
                settings={settings}
                onChange={setSettings}
                items={[
                  ["allowVisitorNotes", "Allow visitor notes", "Show the optional notes field in services."],
                  ["confirmVisitorRemoval", "Confirm visitor removal", "Ask before removing a visitor from a service."],
                  ["includeVisitorsInTotal", "Include visitors in attendance total", "Count service-only visitors in the running total."],
                ]}
              />
            </SettingsSectionCard>
          )}
          {activeSection === "users" && admin && (
            <div className="page-stack">
              <PermissionSummary />
              <UserManagement embedded />
            </div>
          )}
          {activeSection === "audit" && admin && (
            <AuditHistory />
          )}
          {activeSection === "data" && admin && (
            <DataExportSection onExport={(value) => void exportData(value)} />
          )}
          {activeSection === "sync" && (
            <DeviceSyncSection
              pendingCount={pendingCount}
              lastSuccessfulSync={lastSuccessfulSync}
              isSyncing={synchronization.isSyncing}
              syncPhase={synchronization.phase}
              online={online}
              offlineReady={offlineReady}
              diagnostics={syncDiagnostics}
              latestError={storedSyncError ?? synchronization.error ?? undefined}
              admin={admin}
              onSync={async () => {
                setError("");
                setFeedback("Syncing…");
                const outcome = await synchronization.syncNow();
                setFeedback(
                  outcome.status === "synced"
                    ? "All changes synced."
                    : "Some changes remain safely saved on this device.",
                );
                await refreshDeviceStatus();
              }}
              onRefresh={async () => {
                if (pendingCount > 0) {
                  setError("Refresh is unavailable while local changes are waiting to sync.");
                  return;
                }
                const refreshedUser = await refreshAccess();
                if (!refreshedUser) {
                  setError("Your sign-in needs attention before local sync state can be repaired.");
                  return;
                }
                const database = await getDatabase();
                const cursors = await database.getAllFromIndex(
                  "syncCursors",
                  "organizationId",
                  user?.organizationId ?? "",
                );
                await Promise.all(
                  cursors
                    .filter(
                      (cursor) =>
                        !cursor.userId || cursor.userId === user?.userId,
                    )
                    .map((cursor) =>
                      database.delete("syncCursors", cursor.id),
                    ),
                );
                await synchronization.syncNow();
                setFeedback("Local sync state repaired from the server.");
              }}
              onClear={async () => {
                if (!online) {
                  setError(
                    "Connect to the internet before resetting local data so a fresh church copy can be downloaded safely.",
                  );
                  return;
                }
                const warning =
                  "This removes locally stored attendance data and cached church information from this device. Cloud data will not be deleted.";
                if (
                  !(await confirmAction({
                    title: "Clear local device data?",
                    message: warning,
                    confirmLabel: "Continue",
                    tone: "danger",
                  }))
                ) {
                  return;
                }
                if (
                  pendingCount > 0 &&
                  !(await confirmAction({
                    title: "Unsynchronized changes will be lost",
                    message: `${pendingCount} unsynchronized changes will be removed from this device and cannot be recovered from the cloud.`,
                    confirmLabel: "Clear this device",
                    tone: "danger",
                  }))
                ) {
                  return;
                }
                await clearLocalDatabase();
                const outcome = await synchronization.syncNow();
                if (outcome.status !== "synced") {
                  setError(
                    "Local data was cleared, but a fresh church copy could not be downloaded. Retry Sync when the connection is available.",
                  );
                  return;
                }
                await load();
                setFeedback("Local data reset and a fresh church copy downloaded.");
              }}
            />
          )}
          {activeSection === "security" && (
            <SecuritySection
              email={user?.email ?? ""}
              displayName={displayName}
              role={user?.role ?? "admin"}
              organizationName={organization?.name ?? "Abundant Life UPC"}
              lastSignIn={session?.user.last_sign_in_at}
              canEditDisplayName={admin}
              onDisplayNameChange={setDisplayName}
              onSaveDisplayName={() => runSecurityAction(async () => {
                if (!online) {
                  setError("Profile security changes require an internet connection.");
                  return;
                }
                const {
                  data: { session: activeSession },
                } = await getSupabaseClient().auth.getSession();
                if (!activeSession) throw new Error("Your session is required.");
                const response = await fetch("/api/admin/settings/security", {
                  method: "PATCH",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${activeSession.access_token}`,
                  },
                  body: JSON.stringify({ displayName }),
                });
                const body = (await response.json()) as { error?: string };
                if (!response.ok) throw new Error(body.error || "Profile update failed.");
                setFeedback("Display name updated.");
              })}
              onPasswordReset={() => runSecurityAction(async () => {
                if (!online) {
                  setError("Password reset requires an internet connection.");
                  return;
                }
                const { error: resetError } =
                  await getSupabaseClient().auth.resetPasswordForEmail(
                    user?.email ?? "",
                    { redirectTo: `${window.location.origin}/reset-password` },
                  );
                if (resetError) throw resetError;
                setFeedback("Password-reset email sent.");
              })}
              onSignOutAll={() => runSecurityAction(async () => {
                if (!online) {
                  setError("Signing out all sessions requires an internet connection.");
                  return;
                }
                await getSupabaseClient().auth.signOut({ scope: "global" });
                window.location.assign("/login");
              })}
              onSignOut={() => void signOut()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PersonalSettingsSection({
  preferences,
  onChange,
}: {
  preferences: AttendanceExperiencePreferences;
  onChange: (patch: Partial<AttendanceExperiencePreferences>) => unknown;
}) {
  return (
    <div className="page-stack personal-settings">
      <section className="settings-section">
        <div className="settings-card-heading">
          <p className="eyebrow">Appearance</p>
          <h2>Theme</h2>
          <p>Choose how the application looks on this device.</p>
        </div>
        <ThemeSwitcher />
      </section>
      <section className="settings-section">
        <div className="settings-card-heading">
          <p className="eyebrow">Attendance experience</p>
          <h2>Service workspace</h2>
          <p>These preferences are saved only in this browser and create no synchronization traffic.</p>
        </div>
        <div className="settings-card-body">
          <label>
            Default attendance tab
            <select
              value={preferences.defaultTab}
              disabled={preferences.rememberLastTab}
              onChange={(event) =>
                onChange({
                  defaultTab: event.target
                    .value as AttendanceExperiencePreferences["defaultTab"],
                })
              }
            >
              <option value="members">Members</option>
              <option value="visitors">Visitors</option>
            </select>
            <small>
              Used whenever remembering the last tab is turned off.
            </small>
          </label>
          <label className="settings-toggle">
            <span>
              <strong>Remember the last attendance tab</strong>
              <small>Open the next service on the last Members or Visitors tab you used.</small>
            </span>
            <input
              type="checkbox"
              checked={preferences.rememberLastTab}
              onChange={(event) =>
                onChange({ rememberLastTab: event.target.checked })
              }
            />
          </label>
          <label>
            Attendance display density
            <select
              value={preferences.density}
              onChange={(event) =>
                onChange({
                  density: event.target
                    .value as AttendanceExperiencePreferences["density"],
                })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
            <small>Compact fits more member and visitor controls on screen while keeping touch targets usable.</small>
          </label>
        </div>
      </section>
    </div>
  );
}

function SettingsSectionCard({
  eyebrow,
  title,
  description,
  children,
  onSave,
  saving,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <section className="settings-section">
      <div className="settings-card-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-card-body">{children}</div>
      <div className="settings-save-bar">
        <button
          className="button primary"
          type="button"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </section>
  );
}

function SettingsOverview({
  organization,
  userEmail,
  pendingCount,
  syncLabel,
  openSection,
}: {
  organization: Organization | null;
  userEmail: string;
  pendingCount: number;
  syncLabel: string;
  openSection: (section: SettingsSection) => void | Promise<void>;
}) {
  return (
    <div className="page-stack">
      <section className="settings-overview-hero">
        <p className="eyebrow">Current organization</p>
        <h2>{organization?.name ?? "Abundant Life UPC"}</h2>
        <p>{userEmail} · Administrator</p>
        <div className="settings-status-row">
          <span>Application ready</span>
          <span>{syncLabel}</span>
          <span>
            {pendingCount} {pendingCount === 1 ? "change" : "changes"} pending
          </span>
        </div>
      </section>
      <nav className="settings-quick-links" aria-label="Settings quick links">
        {(["general", "services", "users", "sync"] as const).map((id) => {
          const item = sectionDefinitions.find((section) => section.id === id)!;
          return (
            <button type="button" key={id} onClick={() => openSection(id)}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function SettingsToggleList({
  settings,
  onChange,
  items,
}: {
  settings: ApplicationSettings;
  onChange: (settings: ApplicationSettings) => void;
  items: Array<[keyof ApplicationSettings, string, string]>;
}) {
  return (
    <div className="settings-toggle-list">
      {items.map(([key, label, description]) => (
        <label className="settings-toggle" key={key}>
          <span>
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
          <input
            type="checkbox"
            checked={Boolean(settings[key])}
            onChange={(event) =>
              onChange({ ...settings, [key]: event.target.checked })
            }
          />
        </label>
      ))}
    </div>
  );
}

function ServiceSettings({
  settings,
  onChange,
  onSave,
  saving,
}: {
  settings: ApplicationSettings;
  onChange: (settings: ApplicationSettings) => void;
  onSave: () => void;
  saving: boolean;
}) {
  function updateType(id: string, patch: Partial<ServiceTypeSetting>) {
    onChange({
      ...settings,
      serviceTypes: settings.serviceTypes.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    });
  }

  function move(id: string, direction: -1 | 1) {
    const next = [...settings.serviceTypes];
    const index = next.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...settings, serviceTypes: next });
  }

  return (
    <SettingsSectionCard
      eyebrow="Service defaults"
      title="Service settings"
      description="Configure choices for new services. Existing services keep their historical type and time."
      onSave={onSave}
      saving={saving}
    >
      <div className="service-type-settings">
        {settings.serviceTypes.map((type, index) => (
          <article key={type.id}>
            <div className="service-type-fields">
              <label>
                Service type
                <input
                  value={type.name}
                  maxLength={120}
                  onChange={(event) =>
                    updateType(type.id, { name: event.target.value })
                  }
                />
              </label>
              <label>
                Default time
                <input
                  type="time"
                  value={type.defaultTime ?? ""}
                  aria-label={`Default time for ${type.name}`}
                  onChange={(event) =>
                    updateType(type.id, {
                      defaultTime: event.target.value || undefined,
                    })
                  }
                />
              </label>
            </div>
            <div className="service-type-actions">
              <span>{type.enabled ? formatTime(type.defaultTime) : "Disabled"}</span>
              <button
                className="button subtle"
                type="button"
                disabled={index === 0}
                onClick={() => move(type.id, -1)}
                aria-label={`Move ${type.name} up`}
              >
                Up
              </button>
              <button
                className="button subtle"
                type="button"
                disabled={index === settings.serviceTypes.length - 1}
                onClick={() => move(type.id, 1)}
                aria-label={`Move ${type.name} down`}
              >
                Down
              </button>
              <button
                className="button subtle"
                type="button"
                onClick={() => updateType(type.id, { enabled: !type.enabled })}
              >
                {type.enabled ? "Disable" : "Restore"}
              </button>
            </div>
          </article>
        ))}
      </div>
      <button
        className="button secondary"
        type="button"
        onClick={() =>
          onChange({
            ...settings,
            serviceTypes: [
              ...settings.serviceTypes,
              {
                id: crypto.randomUUID(),
                name: `Custom Service ${settings.serviceTypes.length + 1}`,
                enabled: true,
                system: false,
              },
            ],
          })
        }
      >
        ＋ Add custom service type
      </button>
      <div className="settings-subsection">
        <label>
          Default status for new services
          <select
            value={settings.defaultServiceStatus}
            onChange={(event) =>
              onChange({
                ...settings,
                defaultServiceStatus: event.target
                  .value as ApplicationSettings["defaultServiceStatus"],
              })
            }
          >
            <option value="draft">Draft</option>
            <option value="completed">Completed</option>
          </select>
        </label>
        <SettingsToggleList
          settings={settings}
          onChange={onChange}
          items={[
            ["allowAdminReopenCompleted", "Allow Admin to reopen completed services", "Attendance Takers can never reopen completed services."],
            ["confirmComplete", "Confirm before completing", "Ask before marking a service complete."],
            ["confirmArchive", "Confirm before archiving", "Ask before an Admin archives a service."],
          ]}
        />
      </div>
    </SettingsSectionCard>
  );
}

function PermissionSummary() {
  return (
    <section className="settings-section permission-summary">
      <div className="settings-card-heading">
        <p className="eyebrow">Permission summary</p>
        <h2>Church access roles</h2>
      </div>
      <div className="permission-columns">
        <div>
          <h3>Admin</h3>
          <p>Full settings and user access; manage members and services; record attendance.</p>
        </div>
        <div>
          <h3>Attendance Taker</h3>
          <p>View and edit member basics, create services, record attendance, and manage service visitors. No Settings, user management, or permanent deletion.</p>
        </div>
      </div>
    </section>
  );
}

function DataExportSection({
  onExport,
}: {
  onExport: (dataset: ExportDataset | "backup") => void;
}) {
  const exports: Array<[ExportDataset | "backup", string, string]> = [
    ["members", "Active members", "CSV"],
    ["inactive-members", "Inactive members", "CSV"],
    ["services", "Services", "CSV"],
    ["attendance", "Attendance records", "CSV"],
    ["visitors", "Visitors", "CSV"],
    ["backup", "Complete organization backup", "JSON"],
  ];
  return (
    <div className="page-stack">
      <MonthlyAttendanceExport />
      <section className="settings-section">
        <div className="settings-card-heading">
          <p className="eyebrow">Organization data</p>
          <h2>Data & Export</h2>
          <p>Exports contain only this organization and never include passwords, tokens, invitation links, or Supabase credentials.</p>
        </div>
        <div className="export-list">
          {exports.map(([id, label, format]) => (
            <div key={id}>
              <span><strong>{label}</strong><small>{format} · generated from saved church data</small></span>
              <button className="button secondary" type="button" onClick={() => onExport(id)}>
                Export
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-section settings-unavailable">
        <h2>Import and restore</h2>
        <p>Import and restore will be added in a future version.</p>
      </section>
      <section className="settings-section danger-zone">
        <p className="eyebrow">Danger area</p>
        <h2>Organization deletion unavailable</h2>
        <p>Permanent organization deletion is intentionally excluded from this release.</p>
      </section>
    </div>
  );
}

function DeviceSyncSection({
  pendingCount,
  lastSuccessfulSync,
  isSyncing,
  syncPhase,
  online,
  offlineReady,
  diagnostics,
  latestError,
  admin,
  onSync,
  onRefresh,
  onClear,
}: {
  pendingCount: number;
  lastSuccessfulSync?: string;
  isSyncing: boolean;
  syncPhase: string;
  online: boolean;
  offlineReady: boolean;
  diagnostics: SyncQueueItem[];
  latestError?: string;
  admin: boolean;
  onSync: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const detail = syncDiagnosticDetails(latestError);
  const syncLabel = isSyncing
    ? "Syncing"
    : !online
      ? "Offline"
      : latestError || diagnostics.length > 0 || syncPhase === "error"
        ? "Needs attention"
        : "Up to date";
  return (
    <div className="page-stack">
      <section className="settings-section">
        <div className="settings-card-heading">
          <p className="eyebrow">This device</p>
          <h2>Device & Sync</h2>
          <p>Church information is saved on this device first and synchronized automatically.</p>
        </div>
        <dl className="settings-status-list">
          <div><dt>Connection</dt><dd>{online ? "Online" : "Offline"}</dd></div>
          <div><dt>Synchronization</dt><dd>{syncLabel}</dd></div>
          <div><dt>Waiting to sync</dt><dd>{pendingCount}</dd></div>
          <div><dt>Last successful sync</dt><dd>{formatDateTime(lastSuccessfulSync, "Not yet")}</dd></div>
          <div><dt>Offline availability</dt><dd>{offlineReady ? "Available offline" : "Available after the app finishes installing"}</dd></div>
          <div><dt>Local storage</dt><dd>Church data saved on this device</dd></div>
          <div><dt>Device</dt><dd>This browser</dd></div>
        </dl>
        {detail && (
          <div className="notice error sync-diagnostic" role="alert">
            <strong>Latest synchronization error</strong>
            <span>{detail.message}</span>
            {detail.code && <code>Error code: {detail.code}</code>}
          </div>
        )}
        <div className="settings-action-row">
          <button className="button primary" type="button" disabled={isSyncing} onClick={() => void onSync()}>
            {isSyncing ? "Syncing…" : "Retry Sync"}
          </button>
          {admin && (
            <button className="button secondary" type="button" disabled={isSyncing || pendingCount > 0 || !online} onClick={() => void onRefresh()}>
              Repair local sync state
            </button>
          )}
        </div>
        {diagnostics.length > 0 && (
          <div className="settings-subsection" aria-label="Synchronization diagnostics">
            <h3>{admin ? "Admin diagnostics" : "Changes needing attention"}</h3>
            {diagnostics.map((item) => (
              <div className="sync-diagnostic-item" key={item.id}>
                <strong>
                  {humanReadableSyncError({
                    item,
                    message: item.lastError ?? "Synchronization failed",
                  })}
                </strong>
                {admin && (
                  <span>
                    Upload · {item.table} · {item.recordId} · attempt {item.attempts}
                  </span>
                )}
                {syncDiagnosticDetails(item.lastError)?.code && (
                  <code>Error code: {syncDiagnosticDetails(item.lastError)?.code}</code>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="settings-section danger-zone">
        <p className="eyebrow">This device only</p>
        <h2>Reset local data</h2>
        <p>This removes locally stored attendance data from this device. Cloud data will not be deleted.</p>
        <button className="button danger-text" type="button" onClick={() => void onClear()}>
          Reset local data
        </button>
      </section>
    </div>
  );
}

function SecuritySection({
  email,
  displayName,
  role,
  organizationName,
  lastSignIn,
  canEditDisplayName,
  onDisplayNameChange,
  onSaveDisplayName,
  onPasswordReset,
  onSignOutAll,
  onSignOut,
}: {
  email: string;
  displayName: string;
  role: string;
  organizationName: string;
  lastSignIn?: string;
  canEditDisplayName: boolean;
  onDisplayNameChange: (value: string) => void;
  onSaveDisplayName: () => Promise<void>;
  onPasswordReset: () => Promise<void>;
  onSignOutAll: () => Promise<void>;
  onSignOut: () => void;
}) {
  return (
    <div className="page-stack">
      <section className="settings-section">
        <div className="settings-card-heading">
          <p className="eyebrow">Your account</p>
          <h2>Security</h2>
          <p>Manage your profile and Supabase-authenticated session without exposing credentials.</p>
        </div>
        <dl className="settings-status-list">
          <div><dt>Display name</dt><dd>{displayName || "Not set"}</dd></div>
          <div><dt>Email</dt><dd>{email}</dd></div>
          <div><dt>Role</dt><dd>{role === "admin" ? "Admin" : "Attendance Taker"}</dd></div>
          <div><dt>Organization</dt><dd>{organizationName}</dd></div>
          <div><dt>Session</dt><dd>Signed in</dd></div>
          <div><dt>Last sign-in</dt><dd>{formatDateTime(lastSignIn, "Unavailable")}</dd></div>
        </dl>
        {canEditDisplayName && (
          <div className="settings-subsection">
            <label>
              Display name
              <input value={displayName} maxLength={120} onChange={(event) => onDisplayNameChange(event.target.value)} />
            </label>
            <button className="button primary" type="button" onClick={() => void onSaveDisplayName()}>
              Save display name
            </button>
          </div>
        )}
        <div className="settings-action-row">
          <button className="button secondary" type="button" onClick={() => void onPasswordReset()}>
            Send password-reset email
          </button>
          <button className="button subtle" type="button" onClick={() => void onSignOutAll()}>
            Sign out all sessions
          </button>
          <button className="button subtle" type="button" onClick={onSignOut}>
            Sign out this device
          </button>
        </div>
      </section>
    </div>
  );
}
