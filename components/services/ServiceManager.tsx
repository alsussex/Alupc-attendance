"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { useSynchronization } from "@/components/sync/SyncProvider";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirmation } from "@/components/feedback/ConfirmationProvider";
import { EmptyState } from "@/components/feedback/EmptyState";
import { ServicesCalendar } from "@/components/services/ServicesCalendar";
import { AuditHistory } from "@/components/audit/AuditHistory";
import { recordAuditEntry } from "@/lib/audit/audit-repository";
import {
  SERVICE_TYPES,
  DEFAULT_APPLICATION_SETTINGS,
  type ApplicationSettings,
  type ChurchService,
  type Person,
  type ServiceType,
  type ServiceVisitor,
  type SyncQueueItem,
  type UserContext,
} from "@/lib/domain";
import {
  addServiceVisitor,
  adjustSundaySchoolKidsCount,
  adjustUnnamedVisitorCount,
  duplicateService,
  editServiceVisitor,
  findExactMemberMatches,
  findReturningVisitorMatches,
  findMatchingServiceSetup,
  getLastAttendanceDates,
  getOrganizationService,
  getServiceAttendance,
  listActiveMembers,
  listMembers,
  listServiceVisitors,
  removeServiceVisitor,
  removeService,
  saveService,
  saveMember,
  setServiceArchived,
  setMemberAttendance,
  restoreMember,
  type ReturningVisitorMatch,
} from "@/lib/repositories/attendance-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";
import { canReopenCompletedServices, isAdmin } from "@/lib/auth/permissions";
import { serviceSaveFeedback } from "@/lib/services/save-feedback";
import { getOrganizationSettings } from "@/lib/repositories/settings-repository";
import {
  formatChurchDate,
  sortAttendanceMembers,
} from "@/lib/settings/settings";
import {
  attendanceCounts,
  attendancePresentCounts,
  attendanceVisitorBreakdown,
  type AttendanceFilter,
  visibleServiceMembers,
  visibleServiceVisitors,
} from "@/lib/services/attendance-view";
import {
  filterServiceDirectory,
  groupServiceDirectory,
  initialServiceFolderExpansion,
  loadOrganizationServiceDirectory,
  updateExpandedFolder,
  type ServiceDirectoryFilter,
  type ServiceDirectoryItem,
} from "@/lib/services/service-directory";
import {
  listVisitorConflicts,
  resolveVisitorConflict,
} from "@/lib/sync/visitor-conflicts";
import { getPendingChanges } from "@/lib/sync/queue";
import { formatDateTime, formatTime } from "@/lib/format/date-time";
import { useEscapeKey } from "@/lib/ui/keyboard";
import {
  getAttendanceExperiencePreferences,
  getServerAttendanceExperiencePreferences,
  preferredAttendanceStartingTab,
  rememberAttendanceTab,
  subscribeToAttendanceExperiencePreferences,
} from "@/lib/settings/attendance-preferences";
import {
  getPreferredServicesView,
  getServerServicesView,
  setPreferredServicesView,
  subscribeToServicesView,
} from "@/lib/services/view-preference";
import { childProgramForService } from "@/lib/services/child-program";
import { runUndoGroup } from "@/lib/undo/undo-service";
import { nextServiceDefault } from "@/lib/services/next-service-default";

type AttendanceTab = "members" | "visitors" | "history";

function localDate(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function serviceTitle(service: ChurchService) {
  return service.customName || service.serviceType;
}

function childProgramSummary(service: ChurchService) {
  const program = childProgramForService(service.serviceType);
  return program
    ? ` · ${program.label}: ${service.sundaySchoolKidsCount ?? 0}`
    : "";
}

export function ServiceManager() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { syncNow } = useSynchronization();
  const { showToast } = useToast();
  const confirmAction = useConfirmation();
  const servicesView = useSyncExternalStore(
    subscribeToServicesView,
    getPreferredServicesView,
    getServerServicesView,
  );
  const attendancePreferences = useSyncExternalStore(
    subscribeToAttendanceExperiencePreferences,
    getAttendanceExperiencePreferences,
    getServerAttendanceExperiencePreferences,
  );
  const [services, setServices] = useState<ChurchService[]>([]);
  const [serviceDirectory, setServiceDirectory] = useState<
    ServiceDirectoryItem[]
  >([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [settings, setSettings] = useState<ApplicationSettings>(
    DEFAULT_APPLICATION_SETTINGS,
  );
  const [active, setActive] = useState<ChurchService | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visitors, setVisitors] = useState<ServiceVisitor[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [visitorSearch, setVisitorSearch] = useState("");
  const [attendanceTab, setAttendanceTab] =
    useState<AttendanceTab>("members");
  const [attendanceFilter, setAttendanceFilter] =
    useState<AttendanceFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [visitorOpen, setVisitorOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [finishConfirmationOpen, setFinishConfirmationOpen] = useState(false);
  const [editingVisitor, setEditingVisitor] =
    useState<ServiceVisitor | null>(null);
  const [historyVisitor, setHistoryVisitor] =
    useState<ServiceVisitor | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] =
    useState<ChurchService | null>(null);
  const [serviceAction, setServiceAction] = useState<
    "draft" | "completed" | null
  >(null);
  const [actionFeedback, setActionFeedback] = useState("");
  const [visitorConflicts, setVisitorConflicts] = useState<SyncQueueItem[]>([]);
  const [reviewingConflict, setReviewingConflict] =
    useState<SyncQueueItem | null>(null);
  const [serviceSearch, setServiceSearch] = useState("");
  const [serviceFilter, setServiceFilter] =
    useState<ServiceDirectoryFilter>("all");
  const [serviceYear, setServiceYear] = useState("");
  const [serviceMonth, setServiceMonth] = useState("");
  const [serviceTypeFilter, setServiceTypeFilter] = useState("");
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [pendingRecordKeys, setPendingRecordKeys] = useState<Set<string>>(
    new Set(),
  );
  const [recentMemberId, setRecentMemberId] = useState("");
  const [recentVisitorId, setRecentVisitorId] = useState("");
  const handledDashboardIntent = useRef("");
  const pendingServiceRoute = useRef("");
  const pendingServicesListRoute = useRef(false);
  const initializedServiceFolders = useRef("");
  const selectedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef<ChurchService | null>(null);
  const tabScrollPositions = useRef<Record<AttendanceTab, number | null>>({
    members: null,
    visitors: null,
    history: null,
  });
  const tabScrollServiceId = useRef<string | null>(null);
  const pendingTabScrollRestore = useRef<{
    serviceId: string;
    tab: AttendanceTab;
    top: number;
    focus: boolean;
  } | null>(null);
  const memberTabRef = useRef<HTMLButtonElement>(null);
  const visitorTabRef = useRef<HTMLButtonElement>(null);
  const historyTabRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const serviceId = active?.id ?? null;
    if (tabScrollServiceId.current !== serviceId) {
      tabScrollServiceId.current = serviceId;
      tabScrollPositions.current = {
        members: null,
        visitors: null,
        history: null,
      };
      pendingTabScrollRestore.current = null;
      return;
    }

    const pending = pendingTabScrollRestore.current;
    if (
      !pending ||
      pending.serviceId !== serviceId ||
      pending.tab !== attendanceTab
    ) {
      return;
    }

    pendingTabScrollRestore.current = null;
    window.scrollTo({ top: pending.top });
    tabScrollPositions.current[attendanceTab] = window.scrollY;

    if (pending.focus) {
      const tabRef =
        attendanceTab === "members"
          ? memberTabRef
          : attendanceTab === "visitors"
            ? visitorTabRef
            : historyTabRef;
      tabRef.current?.focus({ preventScroll: true });
    }
  }, [active?.id, attendanceTab]);

  useEscapeKey(
    () => {
      if (reviewingConflict) setReviewingConflict(null);
      else if (finishConfirmationOpen) setFinishConfirmationOpen(false);
      else if (historyVisitor) setHistoryVisitor(null);
      else if (editingVisitor) setEditingVisitor(null);
      else if (visitorOpen) setVisitorOpen(false);
      else if (memberOpen) setMemberOpen(false);
      else if (duplicateSource) setDuplicateSource(null);
      else if (editOpen) setEditOpen(false);
      else if (createOpen) setCreateOpen(false);
    },
    Boolean(
      reviewingConflict ||
        finishConfirmationOpen ||
        historyVisitor ||
        editingVisitor ||
        visitorOpen ||
        memberOpen ||
        duplicateSource ||
        editOpen ||
        createOpen,
    ),
  );

  const refreshLists = useCallback(async () => {
    if (!user) return;
    const [directory, settingsRecord, conflicts, pending] = await Promise.all([
      loadOrganizationServiceDirectory(user.organizationId),
      getOrganizationSettings(user.organizationId),
      listVisitorConflicts(user.organizationId),
      getPendingChanges(user.organizationId),
    ]);
    const nextMembers = settingsRecord.settings.showInactiveInAttendance
      ? await listMembers(user.organizationId)
      : await listActiveMembers(user.organizationId);
    setServiceDirectory(directory);
    setServices(directory.map((item) => item.service));
    setMembers(nextMembers);
    setSettings(settingsRecord.settings);
    setVisitorConflicts(conflicts);
    setPendingRecordKeys(
      new Set(pending.map((item) => `${item.table}:${item.recordId}`)),
    );
    return directory;
  }, [user]);

  const openService = useCallback(
    async (
      service: ChurchService,
      options: { resetView?: boolean } = {},
    ) => {
      const [attendance, nextVisitors, serviceMembers] = await Promise.all([
        getServiceAttendance(service.id),
        listServiceVisitors(service.id),
        service.status === "completed" ||
        settings.showInactiveInAttendance
          ? listMembers(service.organizationId)
          : listActiveMembers(service.organizationId),
      ]);
      activeRef.current = service;
      setActive(service);
      const nextSelected = new Set(
        attendance.filter((item) => item.present).map((item) => item.personId),
      );
      selectedRef.current = nextSelected;
      setSelected(nextSelected);
      setMembers(serviceMembers);
      setVisitors(nextVisitors);
      if (options.resetView !== false) {
        setMemberSearch("");
        setVisitorSearch("");
        setAttendanceFilter("all");
        setAttendanceTab(preferredAttendanceStartingTab());
      }
    },
    [settings.showInactiveInAttendance],
  );

  const closeActiveService = useCallback(() => {
    activeRef.current = null;
    setActive(null);
  }, []);

  const navigateToService = useCallback(
    (service: ChurchService) => {
      const query = `service=${encodeURIComponent(service.id)}`;
      pendingServicesListRoute.current = false;
      pendingServiceRoute.current = service.id;
      handledDashboardIntent.current = query;
      void openService(service);
      router.push(`/services?${query}`, { scroll: false });
    },
    [openService, router],
  );

  const navigateBackFromService = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    pendingServicesListRoute.current = true;
    router.replace("/services", { scroll: false });
    closeActiveService();
  }, [closeActiveService, router]);

  useEffect(() => {
    const refresh = () => {
      void refreshLists().then((directory) => {
        if (!directory || !activeRef.current) return;
        const current = directory.find(
          (item) => item.service.id === activeRef.current?.id,
        )?.service;
        if (current) {
          void openService(current, { resetView: false });
        } else {
          activeRef.current = null;
          setActive(null);
        }
      });
    };
    const timer = window.setTimeout(refresh, 0);
    const unsubscribe = subscribeToDataChanges(refresh);
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [openService, refreshLists]);

  useEffect(() => {
    const query = searchParams.toString();
    const parameters = new URLSearchParams(query);
    if (parameters.get("new") === "1") {
      if (handledDashboardIntent.current === query) return;
      handledDashboardIntent.current = query;
      router.replace("/services", { scroll: false });
      const timer = window.setTimeout(() => setCreateOpen(true), 0);
      return () => window.clearTimeout(timer);
    }
    const serviceId = parameters.get("service");
    if (!serviceId) {
      pendingServicesListRoute.current = false;
      if (
        pendingServiceRoute.current &&
        activeRef.current?.id === pendingServiceRoute.current
      ) {
        return;
      }
      pendingServiceRoute.current = "";
      handledDashboardIntent.current = query;
      if (activeRef.current) closeActiveService();
      return;
    }
    if (pendingServicesListRoute.current) return;
    pendingServiceRoute.current = "";
    if (
      handledDashboardIntent.current === query &&
      activeRef.current?.id === serviceId
    ) {
      return;
    }
    const visibleService = services.find(
      (service) => service.id === serviceId,
    );
    if (!user) return;
    const openRequestedService = async () => {
      const requestedService =
        visibleService ??
        (await getOrganizationService(user.organizationId, serviceId));
      if (!requestedService) return;
      handledDashboardIntent.current = query;
      await openService(requestedService);
      if (parameters.get("visitor") === "1") {
        setAttendanceTab("visitors");
        setVisitorOpen(true);
      }
    };
    void openRequestedService();
  }, [closeActiveService, openService, router, searchParams, services, user]);

  useEffect(() => {
    if (!recentMemberId && !recentVisitorId) return;
    const timer = window.setTimeout(() => {
      setRecentMemberId("");
      setRecentVisitorId("");
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [recentMemberId, recentVisitorId]);

  async function toggleMember(personId: string) {
    if (!user || !active || active.status === "completed") return;
    const present = !selectedRef.current.has(personId);
    const next = new Set(selectedRef.current);
    if (present) next.add(personId);
    else next.delete(personId);
    selectedRef.current = next;
    setSelected(next);
    await setMemberAttendance(user, active.id, personId, present);
  }

  async function markAllAbsent() {
    if (
      !user ||
      !active ||
      active.status === "completed" ||
      selectedRef.current.size === 0
    ) {
      return;
    }
    if (!(await confirmAction({
      title: "Mark all members absent?",
      message: "This will clear every Present selection for this service.",
      confirmLabel: "Mark all absent",
      tone: "danger",
    }))) {
      return;
    }
    const previouslySelected = [...selectedRef.current];
    selectedRef.current = new Set();
    setSelected(new Set());
    await runUndoGroup("Mark all members absent", () =>
      Promise.all(
        previouslySelected.map((personId) =>
          setMemberAttendance(user, active.id, personId, false),
        ),
      ),
    );
    await recordAuditEntry(user, {
      entityType: "attendance",
      entityId: active.id,
      action: "attendance_cleared",
      details: {
        serviceId: active.id,
        count: previouslySelected.length,
      },
    });
  }

  async function setStatus(status: "draft" | "completed") {
    if (!user || !active || serviceAction) return;
    if (status === "draft" && active.status === "completed") {
      if (!canReopenCompletedServices(user)) return;
      if (isAdmin(user) && !settings.allowAdminReopenCompleted) return;
      if (
        !(await confirmAction({
          title: "Reopen this service?",
          message:
            "Attendance and visitor editing will become available again immediately.",
          confirmLabel: "Reopen Service",
        }))
      ) {
        return;
      }
    }
    setServiceAction(status);
    setActionFeedback("");
    try {
      if (status === "completed" && navigator.onLine) {
        await syncNow();
        const conflicts = await listVisitorConflicts(
          user.organizationId,
          active.id,
        );
        setVisitorConflicts((current) => [
          ...current.filter(
            (item) => item.conflict?.serviceId !== active.id,
          ),
          ...conflicts,
        ]);
        if (conflicts.length > 0) return;
      }
      const updated = await saveService(user, { ...active, status });
      activeRef.current = updated;
      setActive(updated);
      await refreshLists();
      const outcome = await syncNow();
      setActionFeedback(serviceSaveFeedback(status, outcome.status));
      showToast(
        status === "completed"
          ? "Service finished."
          : active.status === "completed"
            ? "Service reopened."
            : "Attendance saved.",
        { key: `service-status:${active.id}:${status}` },
      );
    } finally {
      setServiceAction(null);
    }
  }

  const filteredMembers = useMemo(() => {
    return visibleServiceMembers(
      sortAttendanceMembers(members, settings.attendanceSort),
      selected,
      active?.status === "completed",
      attendanceFilter,
      memberSearch,
    );
  }, [
    active?.status,
    attendanceFilter,
    memberSearch,
    members,
    selected,
    settings.attendanceSort,
  ]);

  const memberCounts = useMemo(
    () => attendanceCounts(members, selected),
    [members, selected],
  );

  const presentCounts = useMemo(
    () =>
      attendancePresentCounts(
        selected,
        visitors,
        settings.includeVisitorsInTotal,
        active?.unnamedVisitorCount ?? 0,
        active?.sundaySchoolKidsCount ?? 0,
      ),
    [
      active?.sundaySchoolKidsCount,
      active?.unnamedVisitorCount,
      selected,
      settings.includeVisitorsInTotal,
      visitors,
    ],
  );

  const filteredVisitors = useMemo(
    () =>
      visibleServiceVisitors(
        visitors,
        active?.status === "completed",
        visitorSearch,
      ),
    [active?.status, visitorSearch, visitors],
  );
  const childProgram = childProgramForService(active?.serviceType);
  const childProgramCount = childProgram
    ? active?.sundaySchoolKidsCount
    : 0;
  const visitorBreakdown = useMemo(
    () =>
      attendanceVisitorBreakdown(
        visitors,
        active?.unnamedVisitorCount,
        childProgramCount,
      ),
    [active?.unnamedVisitorCount, childProgramCount, visitors],
  );

  function selectAttendanceTab(tab: AttendanceTab, focus = false) {
    if (tab === attendanceTab) return;
    const serviceId = active?.id;
    if (!serviceId) return;
    const currentPosition = window.scrollY;
    tabScrollPositions.current[attendanceTab] = currentPosition;
    pendingTabScrollRestore.current = {
      serviceId,
      tab,
      top: tabScrollPositions.current[tab] ?? currentPosition,
      focus,
    };
    if (tab === "members" || tab === "visitors") {
      rememberAttendanceTab(tab);
    }
    setAttendanceTab(tab);
  }

  function finishService() {
    if (settings.confirmComplete) {
      setFinishConfirmationOpen(true);
      return;
    }
    void setStatus("completed");
  }

  async function changeUnnamedVisitorCount(change: number) {
    if (!user || !active || active.status === "completed") return;
    const updated = await adjustUnnamedVisitorCount(user, active.id, change);
    activeRef.current = updated;
    setActive(updated);
    await refreshLists();
  }

  async function changeSundaySchoolKidsCount(change: number) {
    if (!user || !active || active.status === "completed") return;
    const updated = await adjustSundaySchoolKidsCount(
      user,
      active.id,
      change,
    );
    activeRef.current = updated;
    setActive(updated);
    await refreshLists();
  }

  function highlightCard(id: string) {
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 50);
  }

  async function createQuickMember(
    firstName: string,
    lastName: string,
  ) {
    if (!user || !active || active.status === "completed") return undefined;
    const matches = await findExactMemberMatches(
      user.organizationId,
      `${firstName} ${lastName}`,
    );
    if (matches.length > 0) {
      const lastAttendance = await getLastAttendanceDates(user.organizationId);
      return matches.map((person) => ({
        person,
        lastAttendanceDate: lastAttendance.get(person.id),
      }));
    }
    const member = await saveMember(user, {
      firstName,
      lastName,
    });
    await setMemberAttendance(user, active.id, member.id, true);
    setAttendanceTab("members");
    rememberAttendanceTab("members");
    setRecentMemberId(member.id);
    await refreshLists();
    await openService(active, { resetView: false });
    highlightCard(`member-card-${member.id}`);
    showToast("Member added and marked present.", {
      key: `member-added:${member.id}`,
    });
    return undefined;
  }

  async function useExistingQuickMember(person: Person) {
    if (!user || !active || active.status === "completed") return;
    if (!person.isActive) {
      await restoreMember(user, person.id);
    }
    await setMemberAttendance(user, active.id, person.id, true);
    setAttendanceTab("members");
    rememberAttendanceTab("members");
    setRecentMemberId(person.id);
    await refreshLists();
    await openService(active, { resetView: false });
    highlightCard(`member-card-${person.id}`);
  }

  const visibleServiceDirectory = useMemo(
    () =>
      filterServiceDirectory(
        serviceDirectory,
        serviceFilter,
        serviceSearch,
        undefined,
        {
          year: serviceYear || undefined,
          month: serviceMonth || undefined,
          serviceType: serviceTypeFilter || undefined,
        },
      ),
    [
      serviceDirectory,
      serviceFilter,
      serviceMonth,
      serviceSearch,
      serviceTypeFilter,
      serviceYear,
    ],
  );
  const serviceFilterOptions = useMemo(
    () => ({
      years: [...new Set(serviceDirectory.map(({ service }) => service.serviceDate.slice(0, 4)))].sort(
        (a, b) => b.localeCompare(a),
      ),
      months: [...new Set(serviceDirectory.map(({ service }) => service.serviceDate.slice(5, 7)))].sort(
        (a, b) => b.localeCompare(a),
      ),
      types: [...new Set(serviceDirectory.map(({ service }) => service.serviceType))].sort(
        (a, b) => a.localeCompare(b),
      ),
    }),
    [serviceDirectory],
  );
  const serviceGroups = useMemo(
    () => groupServiceDirectory(visibleServiceDirectory),
    [visibleServiceDirectory],
  );

  useEffect(() => {
    if (!user || serviceGroups.length === 0) return;
    const initializationKey = user.organizationId;
    if (initializedServiceFolders.current === initializationKey) return;
    initializedServiceFolders.current = initializationKey;
    const current = localDate(settings.timezone).slice(0, 7);
    const initial = initialServiceFolderExpansion(
      serviceGroups,
      current,
    );
    setExpandedYears(new Set(initial.years));
    setExpandedMonths(new Set(initial.months));
  }, [serviceGroups, settings.timezone, user]);

  function toggleFolder(
    type: "years" | "months",
    key: string,
    open: boolean,
  ) {
    if (!user) return;
    const setter = type === "years" ? setExpandedYears : setExpandedMonths;
    setter((current) => updateExpandedFolder(current, key, open));
  }

  const activeVisitorConflicts = active
    ? visitorConflicts.filter(
        (item) => item.conflict?.serviceId === active.id,
      )
    : [];
  if (active) {
    const serviceLocked = active.status === "completed";
    return (
      <div
        className={
          [
            "attendance-workspace product-page services-page",
            serviceLocked ? "completed-service-locked" : "",
            attendancePreferences.density === "compact"
              ? "attendance-density-compact"
              : "",
          ]
            .filter(Boolean)
            .join(" ")
        }
      >
        <div className="service-topline attendance-service-header">
          <button
            className="button subtle"
            type="button"
            onClick={navigateBackFromService}
          >
            ← Back
          </button>
          <div className="service-admin-actions">
            <div className="service-workflow-actions">
            <span className={`status-pill ${active.status}`}>{active.status}</span>
            {active.status === "completed" ? (
              canReopenCompletedServices(user) &&
              (!isAdmin(user) || settings.allowAdminReopenCompleted) && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Reopen Service"}
                </button>
              )
            ) : (
              <>
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Save Draft"}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={finishService}
                >
                  {serviceAction === "completed" ? "Saving…" : "Finish Service"}
                </button>
              </>
            )}
            <button
              className="button subtle"
              type="button"
              disabled={serviceAction !== null}
              onClick={() => setDuplicateSource(active)}
            >
              Duplicate Service
            </button>
            </div>
            {isAdmin(user) && (
              <div className="service-management-actions">
                <button
                  className="button subtle"
                  type="button"
                  disabled={serviceLocked}
                  title={
                    serviceLocked
                      ? "Reopen this service before editing its details."
                      : undefined
                  }
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </button>
                <button
                  className="button danger-text"
                  type="button"
                  onClick={async () => {
                    if (!user) return;
                    if (
                      settings.confirmArchive &&
                      !(await confirmAction({
                        title: `Archive ${serviceTitle(active)}?`,
                        message:
                          "The service will leave normal service lists while its history remains preserved.",
                        confirmLabel: "Archive service",
                        tone: "danger",
                      }))
                    ) return;
                    await setServiceArchived(user, active.id, true);
                    activeRef.current = null;
                    setActive(null);
                    await refreshLists();
                  }}
                >
                  Archive
                </button>
                <button
                  className="button danger-text"
                  type="button"
                  onClick={async () => {
                    if (!user) return;
                    if (
                      !(await confirmAction({
                        title: `Remove ${serviceTitle(active)}?`,
                        message:
                          "The service will be removed from normal lists. Attendance history will remain preserved.",
                        confirmLabel: "Remove service",
                        tone: "danger",
                      }))
                    ) return;
                    await removeService(user, active.id);
                    activeRef.current = null;
                    setActive(null);
                    await refreshLists();
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="attendance-heading attendance-service-heading">
          <div>
            <p className="eyebrow">{formatChurchDate(active.serviceDate, settings)}</p>
            <h1>{serviceTitle(active)}</h1>
            <p>
              {active.serviceTime ? `${formatTime(active.serviceTime)} · ` : ""}
              {serviceLocked
                ? "This completed service is read-only."
                : "Select every person who attended. Changes save to this device immediately."}
            </p>
            {active.notes && (
              <p className="service-notes">
                <strong>Service note:</strong> {active.notes}
              </p>
            )}
          </div>
        </div>
        {serviceLocked && (
          <div className="completed-service-lock" role="status">
            <span className="status-pill completed">Completed</span>
            <span>
              This service is locked.
              {canReopenCompletedServices(user) && (!isAdmin(user) || settings.allowAdminReopenCompleted)
                ? " Reopen Service to make changes."
                : " An administrator can reopen it if changes are needed."}
            </span>
          </div>
        )}
        {settings.showAttendanceTotals && (
          <section className="attendance-metrics" aria-live="polite">
            <article className="attendance-metric members">
              <span>Members Present</span>
              <strong>{presentCounts.members}</strong>
            </article>
            <article className="attendance-metric visitors">
              <span>Visitors</span>
              <strong>{presentCounts.visitors}</strong>
              {childProgram && (
                <small>
                  {childProgram.label}: {active.sundaySchoolKidsCount ?? 0}
                </small>
              )}
            </article>
            <article className="attendance-metric total">
              <span>Total Present</span>
              <strong>{presentCounts.total}</strong>
              <small>
                Members + visitors
                {childProgram ? ` + ${childProgram.label}` : ""}
              </small>
            </article>
            <article className="attendance-metric status">
              <span>Service Status</span>
              <strong>
                {active.status === "draft" ? "In Progress" : "Completed"}
              </strong>
            </article>
          </section>
        )}
        {actionFeedback && (
          <div className="notice success" role="status">
            {actionFeedback}
          </div>
        )}
        {activeVisitorConflicts.map((item) => (
          <div className="notice warning visitor-conflict-notice" key={item.id}>
            <div>
              <strong>
                {item.conflict?.visitorName ?? "A visitor"} has changes from
                another device.
              </strong>
              <span>
                {isAdmin(user)
                  ? "Review them before finishing this service."
                  : "An administrator needs to review them before this service can be finished."}
              </span>
            </div>
            {isAdmin(user) && (
              <button
                className="button secondary"
                type="button"
                onClick={() => setReviewingConflict(item)}
              >
                Review Conflict
              </button>
            )}
          </div>
        ))}
        <section className="attendance-people-workspace">
          <div
            className="attendance-tabs"
            role="tablist"
            aria-label="Attendance people"
          >
            <button
              ref={memberTabRef}
              id="attendance-members-tab"
              role="tab"
              type="button"
              aria-selected={attendanceTab === "members"}
              aria-controls="attendance-members-panel"
              tabIndex={attendanceTab === "members" ? 0 : -1}
              className={attendanceTab === "members" ? "active" : ""}
              onClick={() => selectAttendanceTab("members")}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight") return;
                event.preventDefault();
                selectAttendanceTab("visitors", true);
              }}
            >
              <strong>Members</strong>
              <span>{presentCounts.members} present</span>
            </button>
            <button
              ref={visitorTabRef}
              id="attendance-visitors-tab"
              role="tab"
              type="button"
              aria-selected={attendanceTab === "visitors"}
              aria-controls="attendance-visitors-panel"
              tabIndex={attendanceTab === "visitors" ? 0 : -1}
              className={attendanceTab === "visitors" ? "active" : ""}
              onClick={() => selectAttendanceTab("visitors")}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  selectAttendanceTab("members", true);
                } else if (event.key === "ArrowRight" && isAdmin(user)) {
                  event.preventDefault();
                  selectAttendanceTab("history", true);
                }
              }}
            >
              <strong>{settings.visitorLabel}s</strong>
              <span className="attendance-tab-total">
                {visitorBreakdown.total} total
              </span>
              <span
                className="attendance-tab-breakdown"
                aria-label={`${visitorBreakdown.named} named visitors, ${visitorBreakdown.unnamed} unnamed visitors${
                  childProgram
                    ? `, ${visitorBreakdown.children} ${childProgram.label}`
                    : ""
                }`}
              >
                <span aria-hidden="true">{visitorBreakdown.named} named</span>
                <span aria-hidden="true">{visitorBreakdown.unnamed} unnamed</span>
                {childProgram && (
                  <span aria-hidden="true">
                    {visitorBreakdown.children} {childProgram.label}
                  </span>
                )}
              </span>
            </button>
            {isAdmin(user) && (
              <button
                ref={historyTabRef}
                id="attendance-history-tab"
                role="tab"
                type="button"
                aria-selected={attendanceTab === "history"}
                aria-controls="attendance-history-panel"
                tabIndex={attendanceTab === "history" ? 0 : -1}
                className={attendanceTab === "history" ? "active" : ""}
                onClick={() => selectAttendanceTab("history")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  selectAttendanceTab("visitors", true);
                }}
              >
                <strong>History</strong>
                <span>Audit trail</span>
              </button>
            )}
          </div>

          {attendanceTab === "members" && (
            <div
              id="attendance-members-panel"
              role="tabpanel"
              aria-labelledby="attendance-members-tab"
              className="attendance-tab-panel"
            >
              {serviceLocked && (
                <div className="attendance-context-count completed-attendee-count">
                  {memberCounts.present} members attended this service
                </div>
              )}
              {!serviceLocked && (
                <>
                  <div className="panel-toolbar attendance-tab-toolbar">
                    <label className="search-field">
                      <span className="sr-only">Search members</span>
                      <span aria-hidden="true">⌕</span>
                      <input
                        type="search"
                        placeholder="Search members"
                        value={memberSearch}
                        onChange={(event) =>
                          setMemberSearch(event.target.value)
                        }
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={serviceLocked}
                      onClick={() => setMemberOpen(true)}
                    >
                      + Add Member
                    </button>
                  </div>
                  <div className="attendance-controls">
                    <div
                      className="attendance-filters"
                      role="group"
                      aria-label="Filter members"
                    >
                      {(["all", "present", "absent"] as const).map((filter) => (
                        <button
                          className={
                            attendanceFilter === filter
                              ? "attendance-filter active"
                              : "attendance-filter"
                          }
                          type="button"
                          key={filter}
                          aria-pressed={attendanceFilter === filter}
                          onClick={() => setAttendanceFilter(filter)}
                        >
                          {filter === "all"
                            ? `All (${memberCounts.total})`
                            : filter === "present"
                              ? `Present (${memberCounts.present})`
                              : `Absent (${memberCounts.absent})`}
                        </button>
                      ))}
                    </div>
                    <span className="attendance-context-count">
                      {memberCounts.present} of {memberCounts.total} members
                      present
                    </span>
                    <button
                      className="button subtle mark-absent-button"
                      type="button"
                      disabled={serviceLocked || memberCounts.present === 0}
                      onClick={() => void markAllAbsent()}
                    >
                      Mark all absent
                    </button>
                  </div>
                </>
              )}
              <div className="member-card-grid">
                {filteredMembers.map((member) => {
                  const checked = selected.has(member.id);
                  const pending =
                    pendingRecordKeys.has(`people:${member.id}`) ||
                    pendingRecordKeys.has(
                      `service_attendance:${active.id}:${member.id}`,
                    );
                  return (
                    <label
                      id={`member-card-${member.id}`}
                      className={[
                        "attendance-person-card",
                        checked ? "selected" : "",
                        serviceLocked ? "locked" : "",
                        recentMemberId === member.id ? "recently-added" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={member.id}
                      aria-disabled={serviceLocked}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={serviceLocked}
                        aria-label={`${member.displayName}, ${
                          checked ? "present" : "absent"
                        }`}
                        onChange={() => void toggleMember(member.id)}
                      />
                      <span className="attendance-card-check" aria-hidden="true">
                        {checked ? "✓" : ""}
                      </span>
                      <span className="attendance-card-name">
                        <HighlightedText
                          text={member.displayName}
                          query={memberSearch}
                        />
                      </span>
                      <span className="attendance-card-state">
                        {checked ? "Present" : "Mark Present"}
                      </span>
                      {pending && (
                        <span className="card-sync-pending">
                          ● Waiting to sync
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              {filteredMembers.length === 0 && (
                <div className="attendance-empty">
                  <strong>
                    {serviceLocked
                      ? "No members were marked present."
                      : "No members match this view."}
                  </strong>
                  {!serviceLocked && (
                    <span>Try another filter or clear the search.</span>
                  )}
                </div>
              )}
            </div>
          )}

          {attendanceTab === "visitors" && (
            <div
              id="attendance-visitors-panel"
              role="tabpanel"
              aria-labelledby="attendance-visitors-tab"
              className="attendance-tab-panel"
            >
              {!serviceLocked && (
                <div className="panel-toolbar attendance-tab-toolbar">
                  <label className="search-field">
                    <span className="sr-only">Search named visitors</span>
                    <span aria-hidden="true">⌕</span>
                    <input
                      type="search"
                      placeholder={`Search ${settings.visitorLabel.toLocaleLowerCase()}s`}
                      value={visitorSearch}
                      onChange={(event) => setVisitorSearch(event.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    type="button"
                    disabled={serviceLocked}
                    onClick={() => setVisitorOpen(true)}
                  >
                    + Add Visitor
                  </button>
                </div>
              )}
              <section className="unnamed-visitor-counter">
                <div>
                  <h2>Unnamed Visitors</h2>
                  <p>People attending whose names were not recorded.</p>
                </div>
                {!serviceLocked && (
                  <div
                    className="visitor-stepper"
                    role="group"
                    aria-label="Unnamed visitor count"
                  >
                    <button
                      type="button"
                      aria-label="Remove one unnamed visitor"
                      disabled={
                        serviceLocked ||
                        (active.unnamedVisitorCount ?? 0) === 0
                      }
                      onClick={() => void changeUnnamedVisitorCount(-1)}
                    >
                      −
                    </button>
                    <strong aria-live="polite">
                      {active.unnamedVisitorCount ?? 0}
                    </strong>
                    <button
                      type="button"
                      aria-label="Add one unnamed visitor"
                      disabled={serviceLocked}
                      onClick={() => void changeUnnamedVisitorCount(1)}
                    >
                      +
                    </button>
                  </div>
                )}
                {serviceLocked && (
                  <strong className="completed-unnamed-visitor-count">
                    {active.unnamedVisitorCount ?? 0}
                  </strong>
                )}
              </section>
              {childProgram && (
                <section className="unnamed-visitor-counter sunday-school-kids-counter">
                  <div>
                    <h2>Unnamed {childProgram.label}</h2>
                    <p>{childProgram.helperText}</p>
                  </div>
                  {!serviceLocked && (
                    <div
                      className="visitor-stepper"
                      role="group"
                      aria-label={`Unnamed ${childProgram.label} count`}
                    >
                      <button
                        type="button"
                        aria-label={`Remove one from ${childProgram.label}`}
                        disabled={
                          serviceLocked ||
                          (active.sundaySchoolKidsCount ?? 0) === 0
                        }
                        onClick={() => void changeSundaySchoolKidsCount(-1)}
                      >
                        −
                      </button>
                      <strong aria-live="polite">
                        {active.sundaySchoolKidsCount ?? 0}
                      </strong>
                      <button
                        type="button"
                        aria-label={`Add one to ${childProgram.label}`}
                        disabled={serviceLocked}
                        onClick={() => void changeSundaySchoolKidsCount(1)}
                      >
                        +
                      </button>
                    </div>
                  )}
                  {serviceLocked && (
                    <strong className="completed-unnamed-visitor-count">
                      {active.sundaySchoolKidsCount ?? 0}
                    </strong>
                  )}
                </section>
              )}
              <div className="visitor-tab-summary">
                <strong>{visitorBreakdown.total} people in this section</strong>
                <span>
                  {visitorBreakdown.named} named · {visitorBreakdown.unnamed} unnamed
                  {childProgram
                    ? ` · ${visitorBreakdown.children} ${childProgram.label}`
                    : ""}
                </span>
              </div>
              <div className="visitor-card-grid">
                {filteredVisitors.map((visitor) => (
                  <article
                    id={`visitor-card-${visitor.id}`}
                    className={[
                      "visitor-person-card",
                      recentVisitorId === visitor.id ? "recently-added" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={visitor.id}
                  >
                    <span className="visitor-present-check" aria-hidden="true">
                      ✓
                    </span>
                    <span className="visitor-name">
                      <strong>
                        <HighlightedText
                          text={visitor.displayName}
                          query={visitorSearch}
                        />
                      </strong>
                      <small>
                        {visitor.savedAsMember
                          ? "Also saved as member"
                          : "Present this service"}
                      </small>
                      {settings.allowVisitorNotes && visitor.notes && (
                        <small>{visitor.notes}</small>
                      )}
                      {pendingRecordKeys.has(
                        `service_visitors:${visitor.id}`,
                      ) && (
                        <small className="card-sync-pending">
                          ● Waiting to sync
                        </small>
                      )}
                    </span>
                    <span className="visitor-actions">
                      {isAdmin(user) && (
                        <button
                          className="button subtle"
                          type="button"
                          aria-label={`View history for ${visitor.displayName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setHistoryVisitor(visitor);
                          }}
                        >
                          History
                        </button>
                      )}
                      {!serviceLocked && (
                        <>
                          <button
                            className="button subtle"
                            type="button"
                            aria-label={`Edit ${visitor.displayName}`}
                            disabled={serviceLocked}
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingVisitor(visitor);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="button danger-text"
                            type="button"
                            aria-label={`Remove ${visitor.displayName}`}
                            disabled={serviceLocked}
                            onClick={async (event) => {
                              event.stopPropagation();
                              if (!user) return;
                              if (
                                settings.confirmVisitorRemoval &&
                                !(await confirmAction({
                                  title: `Remove ${visitor.displayName}?`,
                                  message:
                                    "This will remove their attendance entry from this service. Permanent member records are not affected.",
                                  confirmLabel: "Remove visitor",
                                  tone: "danger",
                                }))
                              ) {
                                return;
                              }
                              await removeServiceVisitor(user, visitor.id);
                              await openService(active, { resetView: false });
                            }}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  </article>
                ))}
              </div>
              {filteredVisitors.length === 0 && (
                <div className="attendance-empty">
                  <strong>
                    {serviceLocked
                      ? "No named visitors were recorded."
                      : visitorSearch
                      ? `No ${settings.visitorLabel.toLocaleLowerCase()}s match your search.`
                      : `No named ${settings.visitorLabel.toLocaleLowerCase()}s yet.`}
                  </strong>
                  {!serviceLocked && (
                    <span>
                      {visitorSearch
                        ? "Try another name or clear the search."
                        : "Use Add Visitor when a name is available."}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {attendanceTab === "history" && isAdmin(user) && (
            <div
              id="attendance-history-panel"
              role="tabpanel"
              aria-labelledby="attendance-history-tab"
              className="attendance-tab-panel service-history-panel"
            >
              <AuditHistory
                relatedEntityId={active.id}
                compact
              />
            </div>
          )}
        </section>
        <div className="sticky-actions attendance-mobile-actions">
          <span>{presentCounts.total} present</span>
          <div>
            {active.status === "completed" ? (
              canReopenCompletedServices(user) &&
              (!isAdmin(user) || settings.allowAdminReopenCompleted) && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Reopen Service"}
                </button>
              )
            ) : (
              <>
                <button
                  className="button subtle"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={() => void setStatus("draft")}
                >
                  {serviceAction === "draft" ? "Saving…" : "Save Draft"}
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={finishService}
                >
                  {serviceAction === "completed" ? "Saving…" : "Finish Service"}
                </button>
              </>
            )}
          </div>
        </div>
        {finishConfirmationOpen && !serviceLocked && (
          <div className="modal-backdrop">
            <section
              className="modal confirmation-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="finish-service-title"
              aria-describedby="finish-service-description"
            >
              <div>
                <p className="eyebrow">Complete attendance</p>
                <h2 id="finish-service-title">Finish this service?</h2>
                <p id="finish-service-description">
                  Finishing will lock attendance and visitor editing. An
                  administrator can reopen the service later.
                  {settings.warnZeroAttendance && presentCounts.total === 0
                    ? " No attendance has been recorded."
                    : ""}
                </p>
              </div>
              <div className="modal-actions">
                <button
                  className="button subtle"
                  type="button"
                  autoFocus
                  disabled={serviceAction !== null}
                  onClick={() => setFinishConfirmationOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={serviceAction !== null}
                  onClick={async () => {
                    await setStatus("completed");
                    setFinishConfirmationOpen(false);
                  }}
                >
                  {serviceAction === "completed"
                    ? "Saving…"
                    : "Finish Service"}
                </button>
              </div>
            </section>
          </div>
        )}
        {memberOpen && !serviceLocked && (
          <QuickAddMemberModal
            onClose={() => setMemberOpen(false)}
            onCreate={createQuickMember}
            onUseExisting={useExistingQuickMember}
          />
        )}
        {reviewingConflict?.conflict && isAdmin(user) && (
          <VisitorConflictDialog
            item={reviewingConflict}
            onClose={() => setReviewingConflict(null)}
            onResolve={async (strategy, manual) => {
              if (!user) return;
              await resolveVisitorConflict(
                user.organizationId,
                reviewingConflict.id,
                strategy,
                manual,
              );
              setReviewingConflict(null);
              await syncNow();
              await refreshLists();
              await openService(active, { resetView: false });
            }}
          />
        )}
        {visitorOpen && !serviceLocked && (
          <VisitorModal
            settings={settings}
            organizationId={active.organizationId}
            onClose={() => setVisitorOpen(false)}
            onSave={async (input) => {
              if (!user) return;
              const { visitor } = await addServiceVisitor(
                user,
                active.id,
                input,
              );
              setAttendanceTab("visitors");
              rememberAttendanceTab("visitors");
              setRecentVisitorId(visitor.id);
              setVisitorOpen(false);
              await openService(active, { resetView: false });
              await refreshLists();
              highlightCard(`visitor-card-${visitor.id}`);
              showToast("Visitor added.", {
                key: `visitor-added:${visitor.id}`,
              });
            }}
          />
        )}
        {editingVisitor && !serviceLocked && (
          <VisitorModal
            settings={settings}
            organizationId={active.organizationId}
            existing={editingVisitor}
            onClose={() => setEditingVisitor(null)}
            onSave={async (input) => {
              if (!user) return;
              await editServiceVisitor(user, editingVisitor.id, input);
              setEditingVisitor(null);
              await openService(active, { resetView: false });
              showToast("Visitor updated.", {
                key: `visitor-updated:${editingVisitor.id}`,
              });
            }}
          />
        )}
        {historyVisitor && isAdmin(user) && (
          <div className="modal-backdrop">
            <section
              className="modal audit-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="visitor-history-title"
            >
              <div className="modal-heading">
                <div>
                  <p className="eyebrow">Visitor history</p>
                  <h2 id="visitor-history-title">
                    {historyVisitor.displayName}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Close visitor history"
                  onClick={() => setHistoryVisitor(null)}
                >
                  ×
                </button>
              </div>
              <AuditHistory
                entityType="visitor"
                entityId={historyVisitor.id}
                compact
              />
            </section>
          </div>
        )}
        {editOpen && user && !serviceLocked && (
          <ServiceModal
            user={user}
            settings={settings}
            existing={active}
            onClose={() => setEditOpen(false)}
            onSaved={async (service) => {
              setEditOpen(false);
              await refreshLists();
              await openService(service);
              showToast("Service updated.", {
                key: `service-updated:${service.id}`,
              });
            }}
          />
        )}
        {duplicateSource && user && (
          <ServiceModal
            user={user}
            settings={settings}
            duplicateOf={duplicateSource}
            onClose={() => setDuplicateSource(null)}
            onSaved={async (service) => {
              setDuplicateSource(null);
              await refreshLists();
              navigateToService(service);
              showToast("Service duplicated as a new draft.", {
                key: `service-duplicated:${service.id}`,
              });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page-stack product-page services-page">
      <div className="page-heading with-action">
        <div>
          <p className="eyebrow">Attendance</p>
          <h1>Services</h1>
          <p>Create a service, then record attendance by name.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setCreateOpen(true)}>＋ Create service</button>
      </div>
      <div
        className="services-view-switcher"
        role="group"
        aria-label="Services view"
      >
        <button
          type="button"
          className={servicesView === "list" ? "active" : ""}
          aria-pressed={servicesView === "list"}
          onClick={() => setPreferredServicesView("list")}
        >
          List View
        </button>
        <button
          type="button"
          className={servicesView === "calendar" ? "active" : ""}
          aria-pressed={servicesView === "calendar"}
          onClick={() => setPreferredServicesView("calendar")}
        >
          Calendar View
        </button>
      </div>
      {servicesView === "list" ? (
        <>
      <section className="service-directory-toolbar" aria-label="Find and filter services">
        <label className="search-field">
          <span className="sr-only">Search organization services</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={serviceSearch}
            placeholder="Search names, notes, dates, types, or editors"
            onChange={(event) => setServiceSearch(event.target.value)}
          />
        </label>
        <div className="service-directory-filters" role="group" aria-label="Filter services">
          {(["all", "draft", "completed"] as const).map((filter) => (
            <button
              className={serviceFilter === filter ? "active" : ""}
              type="button"
              key={filter}
              aria-pressed={serviceFilter === filter}
              onClick={() => setServiceFilter(filter)}
            >
              {filter === "all"
                ? "All"
                : filter === "draft"
                  ? "Open"
                  : "Completed"}
            </button>
          ))}
        </div>
        <button
          className="button subtle service-filter-disclosure"
          type="button"
          aria-expanded={advancedFiltersOpen}
          aria-controls="service-advanced-filters"
          onClick={() => setAdvancedFiltersOpen((current) => !current)}
        >
          {advancedFiltersOpen ? "Hide filters" : "More filters"}
          {(serviceYear || serviceMonth || serviceTypeFilter) && (
            <span
              className="filter-active-dot"
              aria-label="Advanced filters active"
            />
          )}
        </button>
        {advancedFiltersOpen && (
          <div
            id="service-advanced-filters"
            className="service-advanced-filters"
            aria-label="Advanced service filters"
          >
            <label>
              <span>Year</span>
              <select value={serviceYear} onChange={(event) => setServiceYear(event.target.value)}>
              <option value="">All years</option>
              {serviceFilterOptions.years.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
            </label>
          <label>
            <span>Month</span>
            <select value={serviceMonth} onChange={(event) => setServiceMonth(event.target.value)}>
              <option value="">All months</option>
              {serviceFilterOptions.months.map((month) => (
                <option key={month} value={month}>
                  {new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(
                    new Date(`2026-${month}-01T00:00:00Z`),
                  )}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Service type</span>
            <select value={serviceTypeFilter} onChange={(event) => setServiceTypeFilter(event.target.value)}>
              <option value="">All service types</option>
              {serviceFilterOptions.types.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          {(serviceYear || serviceMonth || serviceTypeFilter || serviceSearch || serviceFilter !== "all") && (
            <button
              className="button subtle"
              type="button"
              onClick={() => {
                setServiceSearch("");
                setServiceFilter("all");
                setServiceYear("");
                setServiceMonth("");
                setServiceTypeFilter("");
              }}
            >
              Clear filters
            </button>
          )}
          </div>
        )}
      </section>
      <section className="service-directory" aria-label="Organization services">
        {serviceGroups.map((yearGroup) => (
          <details
            className="service-year-folder"
            key={yearGroup.year}
            open={
              Boolean(serviceSearch) ||
              serviceFilter !== "all" ||
              Boolean(serviceYear || serviceMonth || serviceTypeFilter) ||
              expandedYears.has(yearGroup.year)
            }
            onToggle={(event) =>
              toggleFolder("years", yearGroup.year, event.currentTarget.open)
            }
          >
            <summary
              aria-expanded={
                Boolean(serviceSearch) ||
                serviceFilter !== "all" ||
                Boolean(serviceYear || serviceMonth || serviceTypeFilter) ||
                expandedYears.has(yearGroup.year)
              }
            >
              <span className="folder-icon" aria-hidden="true">▸</span>
              <strong>{yearGroup.year}</strong>
              <span>
                {yearGroup.serviceCount}{" "}
                {yearGroup.serviceCount === 1 ? "service" : "services"}
              </span>
            </summary>
            <div className="service-month-list">
              {yearGroup.months.map((monthGroup) => (
                <details
                  className="service-month-folder"
                  key={monthGroup.key}
                  open={
                    Boolean(serviceSearch) ||
                    serviceFilter !== "all" ||
                    Boolean(serviceYear || serviceMonth || serviceTypeFilter) ||
                    expandedMonths.has(monthGroup.key)
                  }
                  onToggle={(event) =>
                    toggleFolder(
                      "months",
                      monthGroup.key,
                      event.currentTarget.open,
                    )
                  }
                >
                  <summary
                    aria-expanded={
                      Boolean(serviceSearch) ||
                      serviceFilter !== "all" ||
                      Boolean(serviceYear || serviceMonth || serviceTypeFilter) ||
                      expandedMonths.has(monthGroup.key)
                    }
                  >
                    <span className="folder-icon" aria-hidden="true">▸</span>
                    <strong>{monthGroup.monthName}</strong>
                    <span>
                      {monthGroup.services.length}{" "}
                      {monthGroup.services.length === 1
                        ? "service"
                        : "services"}
                    </span>
                  </summary>
                  <div className="service-folder-rows">
                    {monthGroup.services.map((item) => (
                      <button
                        className="service-directory-row"
                        type="button"
                        key={item.service.id}
                        onClick={() => navigateToService(item.service)}
                      >
                        <span className="service-directory-date">
                          <strong>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              day: "2-digit",
                            })}
                          </strong>
                          <span>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              weekday: "short",
                            })}
                          </span>
                        </span>
                        <span className="service-directory-main">
                          <strong>{serviceTitle(item.service)}</strong>
                          <span>
                            {formatChurchDate(item.service.serviceDate, settings, {
                              year: "numeric",
                            })}
                            {item.service.serviceTime
                              ? ` · ${formatTime(item.service.serviceTime)}`
                              : ""}
                          </span>
                          <small className="service-directory-updated">
                            <span>Updated {formatDateTime(item.service.updatedAt)}</span>
                            {item.lastEditor && <span>By {item.lastEditor}</span>}
                          </small>
                        </span>
                        <span className="service-directory-counts">
                          <strong>{item.totalPresent}</strong>
                          <span>Total present</span>
                          <small className="service-directory-breakdown">
                            {item.membersPresent} members · {item.visitorsPresent} visitors
                            {childProgramSummary(item.service)}
                          </small>
                        </span>
                        <span className="service-directory-state">
                          <span
                            className={`status-pill ${item.service.status}`}
                            aria-label={`Service status: ${item.service.status}`}
                          >
                            {item.service.status === "draft"
                              ? "Draft"
                              : "Completed"}
                          </span>
                          {item.pendingSync && (
                            <small
                              className={`service-sync-state ${item.syncState}`}
                              aria-label={`Synchronization status: ${
                                item.syncState === "conflict" && !isAdmin(user)
                                  ? "needs attention"
                                  : item.syncState
                              }`}
                            >
                              {item.syncState === "uploading"
                                ? "↑ Uploading"
                                : item.syncState === "conflict"
                                  ? isAdmin(user)
                                    ? "! Conflict"
                                    : "! Needs attention"
                                  : "● Sync pending"}
                            </small>
                          )}
                          {!item.pendingSync && (
                            <small
                              className="service-sync-state synced"
                              aria-label="Synchronization status: synced"
                            >
                              ✓ Synced
                            </small>
                          )}
                        </span>
                        <span className="service-row-arrow" aria-hidden="true">
                          ›
                        </span>
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
        {services.length > 0 && visibleServiceDirectory.length === 0 && (
          <section className="empty-panel full-width">
            <EmptyState
              compact
              icon="⌕"
              title="No services match"
              message="Try another search or select a different status."
            />
          </section>
        )}
        {!services.length && (
          <section className="empty-panel full-width">
            <EmptyState
              compact
              icon="+"
              title="Create your first service"
              message="The active member list will be ready for attendance as soon as you create it."
              action={
                <button
                  className="button primary"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                >
                  Create service
                </button>
              }
            />
          </section>
        )}
      </section>
        </>
      ) : (
        <ServicesCalendar
          items={serviceDirectory}
          currentMonthKey={localDate(settings.timezone).slice(0, 7)}
          todayKey={localDate(settings.timezone)}
          weekStart={settings.weekStart}
          onOpenService={navigateToService}
        />
      )}
      {createOpen && user && (
        <ServiceModal
          user={user}
          settings={settings}
          onClose={() => setCreateOpen(false)}
          onSaved={async (service) => {
            setCreateOpen(false);
            await refreshLists();
            navigateToService(service);
            showToast("Service created.", {
              key: `service-created:${service.id}`,
            });
          }}
        />
      )}
    </div>
  );

}

export function ServiceModal({
  user,
  onClose,
  onSaved,
  existing,
  duplicateOf,
  settings,
  currentDate,
}: {
  user: UserContext;
  onClose: () => void;
  onSaved: (service: ChurchService) => void | Promise<void>;
  existing?: ChurchService;
  duplicateOf?: ChurchService;
  settings: ApplicationSettings;
  currentDate?: Date;
}) {
  const [modalSettings] = useState(settings);
  const template = existing ?? duplicateOf;
  const isDuplicate = Boolean(duplicateOf && !existing);
  const enabledTypes = modalSettings.serviceTypes.filter((item) => item.enabled);
  const availableTypes =
    template &&
    !enabledTypes.some((item) => item.name === template.serviceType)
      ? [
          ...enabledTypes,
          {
            id: `historical-${template.serviceType}`,
            name: template.serviceType,
            enabled: false,
            system: false,
          },
        ]
      : enabledTypes;
  const [suggestedService] = useState(() =>
    nextServiceDefault(currentDate ?? new Date(), modalSettings.timezone),
  );
  const suggestedType = availableTypes.find(
    (item) => item.id === suggestedService.serviceTypeId,
  );
  const initialType =
    template?.serviceType ??
    suggestedType?.name ??
    availableTypes[0]?.name ??
    SERVICE_TYPES[0];
  const [date, setDate] = useState(
    existing?.serviceDate ?? (isDuplicate ? "" : suggestedService.serviceDate),
  );
  const [type, setType] = useState<ServiceType>(initialType);
  const [serviceTime, setServiceTime] = useState(
    template?.serviceTime ??
      availableTypes.find((item) => item.name === initialType)?.defaultTime ??
      (initialType === suggestedType?.name ? suggestedService.serviceTime : ""),
  );
  const [customName, setCustomName] = useState(template?.customName ?? "");
  const [notes, setNotes] = useState(template?.notes ?? "");
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function updateField(update: () => void) {
    update();
    setDuplicateWarning("");
    setFormError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    if (!date) {
      setFormError("Choose a new service date.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError("");
    const input = {
      serviceDate: date,
      serviceType: type,
      customName,
      serviceTime,
      notes,
    };
    try {
      if (isDuplicate && !duplicateWarning) {
        const matches = await findMatchingServiceSetup(
          user.organizationId,
          input,
        );
        if (matches.length > 0) {
          setDuplicateWarning(
            "A matching service already exists on this date and time. Review the details or deliberately create another service.",
          );
          return;
        }
      }
      const service = isDuplicate
        ? await duplicateService(user, duplicateOf!.id, input)
        : await saveService(user, {
            id: existing?.id,
            ...input,
            status: existing?.status ?? modalSettings.defaultServiceStatus,
          });
      await onSaved(service);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "The service could not be saved.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const title = existing
    ? "Edit service"
    : isDuplicate
      ? "Duplicate service"
      : "Create a service";

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-modal-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">
              {existing
                ? "Service details"
                : isDuplicate
                  ? "New service setup"
                  : "New attendance list"}
            </p>
            <h2 id="service-modal-title">{title}</h2>
            {isDuplicate && (
              <p className="muted modal-intro">
                Attendance and visitors will start empty. Choose a date and
                review the copied setup before creating the draft.
              </p>
            )}
          </div>
          <button
            className="icon-button"
            aria-label="Close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            Service date
            <input
              type="date"
              value={date}
              onChange={(event) =>
                updateField(() => setDate(event.target.value))
              }
              required
              autoFocus={isDuplicate}
            />
          </label>
          <label>
            Service type
            <select
              value={type}
              onChange={(event) => {
                const nextType = event.target.value;
                updateField(() => {
                  setType(nextType);
                  setServiceTime(
                    availableTypes.find((item) => item.name === nextType)
                      ?.defaultTime ?? "",
                  );
                });
              }}
            >
              {availableTypes.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Service time <span className="optional">(optional)</span>
            <input
              type="time"
              value={serviceTime}
              onChange={(event) =>
                updateField(() => setServiceTime(event.target.value))
              }
            />
          </label>
          {(isDuplicate ||
            availableTypes.find((item) => item.name === type)?.id ===
              "special-service" ||
            type === "Other") && (
            <label>
              Custom service name{" "}
              <span className="optional">(optional)</span>
              <input
                value={customName}
                onChange={(event) =>
                  updateField(() => setCustomName(event.target.value))
                }
                placeholder="e.g. Christmas Eve"
              />
            </label>
          )}
          <label>
            Service notes <span className="optional">(optional)</span>
            <textarea
              value={notes}
              maxLength={4000}
              rows={4}
              onChange={(event) =>
                updateField(() => setNotes(event.target.value))
              }
              placeholder="Add setup details, reminders, or a short service note"
            />
          </label>
          {duplicateWarning && (
            <div className="form-warning" role="alert">
              <strong>Possible duplicate service</strong>
              <span>{duplicateWarning}</span>
            </div>
          )}
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={submitting}>
              {submitting
                ? "Creating..."
                : existing
                  ? "Save changes"
                  : isDuplicate
                    ? duplicateWarning
                      ? "Create duplicate anyway"
                      : "Create duplicate"
                    : "Create and take attendance"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

const VISITOR_CONFLICT_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  display_name: "Display name",
  notes: "Notes",
  deleted_at: "Removed from service",
  service_id: "Service",
  saved_as_member: "Saved as member",
  member_person_id: "Linked member",
};

function conflictValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function VisitorConflictDialog({
  item,
  onClose,
  onResolve,
}: {
  item: SyncQueueItem;
  onClose: () => void;
  onResolve: (
    strategy: "local" | "server" | "manual",
    manual?: { firstName: string; lastName: string; notes?: string },
  ) => Promise<void>;
}) {
  const conflict = item.conflict!;
  const [manualOpen, setManualOpen] = useState(false);
  const [firstName, setFirstName] = useState(
    String(item.payload.first_name ?? ""),
  );
  const [lastName, setLastName] = useState(
    String(item.payload.last_name ?? ""),
  );
  const [notes, setNotes] = useState(String(item.payload.notes ?? ""));
  const [saving, setSaving] = useState(false);

  async function resolve(
    strategy: "local" | "server" | "manual",
    manual?: { firstName: string; lastName: string; notes?: string },
  ) {
    setSaving(true);
    try {
      await onResolve(strategy, manual);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal visitor-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="visitor-conflict-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Synchronization review</p>
            <h2 id="visitor-conflict-title">{conflict.visitorName}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p>
          This visitor was changed on this device and on another device. Choose
          which information should be kept.
        </p>
        <div className="visitor-conflict-fields">
          {conflict.fields.map((field) => (
            <section key={field.field}>
              <h3>{VISITOR_CONFLICT_LABELS[field.field] ?? field.field}</h3>
              <div>
                <span>
                  <small>This device</small>
                  <strong>{conflictValue(field.localValue)}</strong>
                </span>
                <span>
                  <small>Server</small>
                  <strong>{conflictValue(field.serverValue)}</strong>
                </span>
              </div>
            </section>
          ))}
        </div>
        <p className="form-note">
          Local update:{" "}
          {conflict.localUpdatedAt
            ? new Date(conflict.localUpdatedAt).toLocaleString()
            : "Unknown"}
          {" · "}Server update:{" "}
          {conflict.serverUpdatedAt
            ? new Date(conflict.serverUpdatedAt).toLocaleString()
            : "Unknown"}
        </p>
        <details className="visitor-conflict-diagnostics">
          <summary>Technical details</summary>
          <dl>
            <div>
              <dt>Visitor record</dt>
              <dd>{conflict.visitorId}</dd>
            </div>
            <div>
              <dt>Service record</dt>
              <dd>{conflict.serviceId}</dd>
            </div>
            <div>
              <dt>Organization</dt>
              <dd>{conflict.organizationId}</dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>
                This device {conflict.localVersion ?? "unknown"} · Server{" "}
                {conflict.serverVersion ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt>Last editors</dt>
              <dd>
                This device {conflict.localUpdatedBy ?? "unknown"} · Server{" "}
                {conflict.serverUpdatedBy ?? "unknown"}
              </dd>
            </div>
          </dl>
        </details>
        {manualOpen && (
          <div className="form-stack visitor-conflict-manual">
            <div className="form-grid">
              <label>
                First name
                <input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </label>
              <label>
                Last name
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={saving}
              onClick={() =>
                void resolve("manual", { firstName, lastName, notes })
              }
            >
              {saving ? "Resolving…" : "Save merged visitor"}
            </button>
          </div>
        )}
        <div className="modal-actions visitor-conflict-actions">
          <button
            className="button subtle"
            type="button"
            disabled={saving}
            onClick={() => void resolve("server")}
          >
            Keep Server
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={saving}
            onClick={() => setManualOpen((current) => !current)}
          >
            Merge Manually
          </button>
          <button
            className="button primary"
            type="button"
            disabled={saving}
            onClick={() => void resolve("local")}
          >
            Keep Local
          </button>
        </div>
      </section>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const index = text.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-match">
        {text.slice(index, index + trimmed.length)}
      </mark>
      {text.slice(index + trimmed.length)}
    </>
  );
}

function formatMemberMatchDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function QuickAddMemberModal({
  onClose,
  onCreate,
  onUseExisting,
}: {
  onClose: () => void;
  onCreate: (
    firstName: string,
    lastName: string,
  ) => Promise<
    | Array<{ person: Person; lastAttendanceDate?: string }>
    | undefined
  >;
  onUseExisting: (person: Person) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [matches, setMatches] = useState<
    Array<{ person: Person; lastAttendanceDate?: string }>
  >([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setSaving(true);
    setError("");
    try {
      const exactMatches = await onCreate(firstName, lastName);
      if (exactMatches?.length) {
        setMatches(exactMatches);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add member.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUseExisting(person: Person) {
    setSaving(true);
    setError("");
    try {
      await onUseExisting(person);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not use this member.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-member-title"
      >
        <div className="modal-heading">
          <div>
            <p className="eyebrow">This service</p>
            <h2 id="quick-member-title">Add a member</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="form-grid">
            <label>
              First name
              <input
                autoFocus
                value={firstName}
                onChange={(event) => {
                  setFirstName(event.target.value);
                  setMatches([]);
                }}
                required
              />
            </label>
            <label>
              Last name
              <input
                value={lastName}
                onChange={(event) => {
                  setLastName(event.target.value);
                  setMatches([]);
                }}
                required
              />
            </label>
          </div>
          {matches.length === 1 && (
            <div className="notice warning duplicate-member-warning" role="alert">
              <strong>
                {matches[0].person.isActive && !matches[0].person.deletedAt
                  ? "This member already exists."
                  : matches[0].person.deletedAt
                    ? "A previously removed member with this name already exists."
                    : "An inactive member with this name already exists."}
              </strong>
              <span>
                {matches[0].person.isActive && !matches[0].person.deletedAt
                  ? "Use the existing member instead of creating a duplicate."
                  : matches[0].person.deletedAt
                    ? "Would you like to restore them?"
                    : "Would you like to reactivate the existing member instead?"}
              </span>
              <div>
                <button
                  className="button secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => void handleUseExisting(matches[0].person)}
                >
                  {matches[0].person.isActive && !matches[0].person.deletedAt
                    ? "Use Existing Member"
                    : matches[0].person.deletedAt
                      ? "Restore Existing Member"
                      : "Reactivate Existing Member"}
                </button>
              </div>
            </div>
          )}
          {matches.length > 1 && (
            <div className="notice warning duplicate-member-warning" role="alert">
              <strong>Multiple members share this name.</strong>
              <span>
                Choose the correct existing record. No member will be restored
                automatically.
              </span>
              <div className="member-match-list">
                {matches.map(({ person, lastAttendanceDate }) => (
                  <article key={person.id}>
                    <div>
                      <strong>{person.displayName}</strong>
                      <span>
                        {person.deletedAt
                          ? "Removed"
                          : person.isActive
                            ? "Active"
                            : "Inactive"}{" "}
                        · Added {formatMemberMatchDate(person.createdAt)} ·
                        Last attendance{" "}
                        {lastAttendanceDate
                          ? formatMemberMatchDate(lastAttendanceDate)
                          : "Not available"}
                      </span>
                    </div>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={saving}
                      onClick={() => void handleUseExisting(person)}
                    >
                      {person.isActive && !person.deletedAt
                        ? "Use Existing Member"
                        : person.deletedAt
                          ? "Restore Existing Member"
                          : "Reactivate Existing Member"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <p className="form-note">
            The member will be added to the church directory and marked present
            for this service. This works while offline.
          </p>
          <div className="modal-actions">
            <button
              className="button subtle"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            {matches.length === 0 && (
              <button className="button primary" disabled={saving}>
                {saving ? "Adding…" : "Add member and mark present"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function VisitorModal({
  onClose,
  onSave,
  existing,
  settings,
  organizationId,
}: {
  onClose: () => void;
  onSave: (input: {
    firstName: string;
    lastName: string;
    saveAsMember: boolean;
    notes?: string;
    fallbackName?: string;
    returningVisitorPersonId?: string;
    legacyVisitorIds?: string[];
  }) => Promise<void>;
  existing?: ServiceVisitor;
  settings: ApplicationSettings;
  organizationId: string;
}) {
  const [firstName, setFirstName] = useState(existing?.firstName ?? "");
  const [lastName, setLastName] = useState(existing?.lastName ?? "");
  const [saveAsMember, setSaveAsMember] = useState(
    existing?.savedAsMember ?? false,
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [matches, setMatches] = useState<ReturningVisitorMatch[]>([]);
  const [selectedMatchKey, setSelectedMatchKey] = useState("");
  const [differentPerson, setDifferentPerson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (existing || saveAsMember || !firstName.trim()) {
        setMatches([]);
        setSelectedMatchKey("");
        return;
      }
      void findReturningVisitorMatches(
        organizationId,
        `${firstName} ${lastName}`,
      ).then((nextMatches) => {
        if (cancelled) return;
        setMatches(nextMatches);
        setSelectedMatchKey(nextMatches.length === 1 ? nextMatches[0].key : "");
        setDifferentPerson(false);
      });
    }, existing || saveAsMember || !firstName.trim() ? 0 : 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [existing, firstName, lastName, organizationId, saveAsMember]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (matches.length > 1 && !differentPerson && !selectedMatchKey) {
      setError("Choose the matching returning visitor or indicate that this is someone else.");
      return;
    }
    const selectedMatch = differentPerson
      ? undefined
      : matches.find((match) => match.key === selectedMatchKey);
    setSaving(true);
    setError("");
    try {
      await onSave({
        firstName,
        lastName,
        saveAsMember,
        notes,
        fallbackName: settings.visitorLabel,
        returningVisitorPersonId: selectedMatch?.visitorPersonId,
        legacyVisitorIds: selectedMatch?.legacyVisitorIds,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The visitor could not be added.");
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="visitor-title">
        <div className="modal-heading"><div><p className="eyebrow">This service</p><h2 id="visitor-title">{existing ? `Edit ${settings.visitorLabel.toLocaleLowerCase()}` : `Add a ${settings.visitorLabel.toLocaleLowerCase()}`}</h2></div><button className="icon-button" aria-label="Close" type="button" onClick={onClose}>×</button></div>
        <form className="form-stack" onSubmit={submit}>
          <div className="form-grid">
            <label>First name<input autoFocus value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></label>
            <label>Last name <span className="optional">(optional)</span><input value={lastName} onChange={(event) => setLastName(event.target.value)} /></label>
          </div>
          {!existing && !saveAsMember && matches.length === 1 && !differentPerson && (
            <div className="notice success duplicate-member-warning" role="status">
              <strong>Returning visitor found</strong>
              <span>
                {matches[0].displayName} · {matches[0].visitCount}{" "}
                {matches[0].visitCount === 1 ? "previous visit" : "previous visits"}
                {matches[0].lastVisitDate
                  ? ` · Last attended ${formatChurchDate(matches[0].lastVisitDate, settings)}`
                  : ""}
              </span>
              <div>
                <button
                  className="button subtle"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setDifferentPerson(true);
                    setSelectedMatchKey("");
                  }}
                >
                  This is someone else
                </button>
              </div>
            </div>
          )}
          {!existing && !saveAsMember && matches.length > 1 && !differentPerson && (
            <div className="notice warning duplicate-member-warning" role="alert">
              <strong>More than one returning visitor has this name.</strong>
              <span>Choose the correct person. The app will never merge people by name alone.</span>
              <div className="member-match-list">
                {matches.map((match) => (
                  <article key={match.key}>
                    <div>
                      <strong>{match.displayName}</strong>
                      <span>
                        {match.visitCount} {match.visitCount === 1 ? "previous visit" : "previous visits"}
                        {match.lastVisitDate
                          ? ` · Last attended ${formatChurchDate(match.lastVisitDate, settings)}`
                          : ""}
                      </span>
                    </div>
                    <button
                      className={`button ${selectedMatchKey === match.key ? "primary" : "secondary"}`}
                      type="button"
                      disabled={saving}
                      onClick={() => setSelectedMatchKey(match.key)}
                    >
                      {selectedMatchKey === match.key ? "Selected" : "Use this visitor"}
                    </button>
                  </article>
                ))}
              </div>
              <button
                className="button subtle"
                type="button"
                disabled={saving}
                onClick={() => {
                  setDifferentPerson(true);
                  setSelectedMatchKey("");
                }}
              >
                This is someone else
              </button>
            </div>
          )}
          {!existing && differentPerson && matches.length > 0 && (
            <div className="notice info" role="status">
              <span>A separate visitor profile will be created for this person.</span>
              <button
                className="button subtle"
                type="button"
                disabled={saving}
                onClick={() => {
                  setDifferentPerson(false);
                  setSelectedMatchKey(matches.length === 1 ? matches[0].key : "");
                }}
              >
                Use returning visitor instead
              </button>
            </div>
          )}
          {settings.allowVisitorNotes && (
            <label>
              Notes <span className="optional">(optional)</span>
              <textarea
                value={notes}
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Accessibility, follow-up, or service notes"
              />
            </label>
          )}
          {!existing && (
            <label className="choice-row">
              <input type="checkbox" checked={saveAsMember} onChange={(event) => setSaveAsMember(event.target.checked)} />
              <span><strong>Save as member for future services</strong><small>They will appear in future attendance lists.</small></span>
            </label>
          )}
          {existing?.savedAsMember && (
            <p className="form-note">
              This visitor is linked to a permanent member. Editing this
              service entry does not change the permanent member record.
            </p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions"><button className="button subtle" type="button" onClick={onClose} disabled={saving}>Cancel</button><button className="button primary" disabled={saving}>{saving ? "Saving…" : existing ? "Save visitor" : !differentPerson && matches.length === 1 ? "Add returning visit" : "Add visitor"}</button></div>
        </form>
      </section>
    </div>
  );
}
