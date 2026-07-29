"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { isAdmin } from "@/lib/auth/permissions";
import { SyncBanner, SyncIndicator } from "./SyncIndicator";
import {
  getOrganization,
  getOrganizationSettings,
} from "@/lib/repositories/settings-repository";
import { subscribeToDataChanges } from "@/lib/storage/data-events";

const navigation = [
  { href: "/dashboard", label: "Dashboard", glyph: "D" },
  { href: "/people", label: "People", glyph: "P" },
  { href: "/services", label: "Services", glyph: "S" },
];

const adminNavigation = [{ href: "/settings", label: "Settings", glyph: "⚙" }];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [churchName, setChurchName] = useState("Abundant Life UPC");
  const [shortName, setShortName] = useState("ALUPC");
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
  const visibleNavigation = isAdmin(user)
    ? [...navigation, ...adminNavigation]
    : navigation;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">{shortName.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{churchName}</strong>
            <span>Attendance workspace</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {visibleNavigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname.startsWith(item.href) ? "nav-link active" : "nav-link"}
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <SyncIndicator />
          <span className="account-email">
            {user?.email} · {user?.role === "admin" ? "Admin" : "Attendance Taker"}
          </span>
          <button
            className="button subtle full"
            type="button"
            onClick={() => void signOut()}
          >
            Log out
          </button>
        </div>
      </aside>
      <div className="content-column">
        <header className="topbar">
          <div className="mobile-brand">{churchName}</div>
          <SyncIndicator />
        </header>
        <main className="page-content">
          <SyncBanner />
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {visibleNavigation.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={
              pathname.startsWith(item.href)
                ? "mobile-nav-link active"
                : "mobile-nav-link"
            }
            aria-current={pathname.startsWith(item.href) ? "page" : undefined}
          >
            <span aria-hidden="true">{item.glyph}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
