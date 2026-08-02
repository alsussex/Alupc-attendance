"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CalendarDays,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { isAdmin } from "@/lib/auth/permissions";
import {
  getSidebarCollapsedPreference,
  setSidebarCollapsedPreference,
  subscribeToSidebarPreference,
} from "@/lib/navigation/sidebar-preference";
import { SyncBanner, SyncIndicator } from "./SyncIndicator";
import {
  getOrganization,
  getOrganizationSettings,
} from "@/lib/repositories/settings-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

interface NavigationItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const navigation: NavigationItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/people", label: "People", icon: UsersRound },
  { href: "/services", label: "Services", icon: CalendarDays },
];

const adminNavigation: NavigationItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [churchName, setChurchName] = useState("Abundant Life UPC");
  const [shortName, setShortName] = useState("ALUPC");
  const sidebarCollapsed = useSyncExternalStore(
    subscribeToSidebarPreference,
    getSidebarCollapsedPreference,
    () => false,
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const refreshBrand = useCallback(async () => {
    if (!user) return;
    const [organization, settings] = await Promise.all([
      getOrganization(user.organizationId),
      getOrganizationSettings(user.organizationId),
    ]);
    setChurchName(organization?.name ?? "Abundant Life UPC");
    setShortName(settings.settings.shortName);
  }, [user]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshBrand(), 0);
    const unsubscribe = subscribeToDataChanges(() => void refreshBrand());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshBrand]);
  const closeMobileMenu = useCallback((restoreFocus = true) => {
    setMobileMenuOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => mobileMenuButtonRef.current?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const desktopMedia = window.matchMedia?.("(min-width: 901px)");
    const closeAtDesktopWidth = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileMenuOpen(false);
    };
    document.body.style.overflow = "hidden";
    mobileCloseButtonRef.current?.focus();
    desktopMedia?.addEventListener("change", closeAtDesktopWidth);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktopMedia?.removeEventListener("change", closeAtDesktopWidth);
    };
  }, [mobileMenuOpen]);

  function handleMobileMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMobileMenu();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsedPreference(next);
  }
  const visibleNavigation = isAdmin(user)
    ? [...navigation, ...adminNavigation]
    : navigation;

  return (
    <div
      className={
        sidebarCollapsed ? "app-layout sidebar-collapsed" : "app-layout"
      }
    >
      <aside className="sidebar" aria-label="Application sidebar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">{shortName.slice(0, 2).toUpperCase()}</span>
          <div className="sidebar-label">
            <strong>{churchName}</strong>
            <span>Attendance workspace</span>
          </div>
        </div>
        <button
          className="sidebar-toggle"
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelLeftClose aria-hidden="true" />
          )}
        </button>
        <nav aria-label="Main navigation">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "nav-link active" : "nav-link"}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-glyph" aria-hidden="true">
                  <Icon />
                </span>
                <span className="sidebar-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-label"><SyncIndicator /></div>
          <span className="account-email sidebar-label">
            {user?.email} · {user?.role === "admin" ? "Admin" : "Attendance Taker"}
          </span>
          <button
            className="button subtle full"
            type="button"
            onClick={() => void signOut()}
            aria-label="Log out"
            title={sidebarCollapsed ? "Log out" : undefined}
          >
            <LogOut aria-hidden="true" />
            <span className="sidebar-label">Log out</span>
          </button>
        </div>
      </aside>
      <div className="content-column">
        <header className="topbar">
          <button
            ref={mobileMenuButtonRef}
            className="mobile-menu-button"
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation-panel"
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="mobile-brand">{churchName}</div>
          <SyncIndicator />
        </header>
        <main className="page-content">
          <SyncBanner />
          {children}
        </main>
      </div>
      {mobileMenuOpen && (
        <div
          className="mobile-nav-overlay"
          onKeyDown={handleMobileMenuKeyDown}
        >
          <button
            className="mobile-nav-backdrop"
            type="button"
            tabIndex={-1}
            aria-label="Close navigation menu"
            onClick={() => closeMobileMenu()}
          />
          <aside
            id="mobile-navigation-panel"
            className="mobile-nav-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
          >
            <div className="mobile-nav-heading">
              <div className="brand-block">
                <span className="brand-mark" aria-hidden="true">
                  {shortName.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <strong>{churchName}</strong>
                  <span>Attendance workspace</span>
                </div>
              </div>
              <button
                ref={mobileCloseButtonRef}
                className="mobile-nav-close"
                type="button"
                aria-label="Close navigation menu"
                onClick={() => closeMobileMenu()}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <nav className="mobile-nav" aria-label="Mobile navigation">
              {visibleNavigation.map((item) => {
                const Icon = item.icon;
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? "mobile-nav-link active" : "mobile-nav-link"}
                    aria-current={active ? "page" : undefined}
                    onClick={() => closeMobileMenu(false)}
                  >
                    <span aria-hidden="true"><Icon /></span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mobile-nav-footer">
              <SyncIndicator />
              <span className="account-email">
                {user?.email} · {user?.role === "admin" ? "Admin" : "Attendance Taker"}
              </span>
              <button
                className="button subtle full"
                type="button"
                onClick={() => void signOut()}
              >
                <LogOut aria-hidden="true" />
                Log out
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
