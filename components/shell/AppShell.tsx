"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { SyncBanner, SyncIndicator } from "./SyncIndicator";

const navigation = [
  { href: "/dashboard", label: "Dashboard", glyph: "D" },
  { href: "/people", label: "People", glyph: "P" },
  { href: "/services", label: "Services", glyph: "S" },
  { href: "/settings", label: "Settings", glyph: "⚙" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">CA</span>
          <div>
            <strong>Abundant Life UPC</strong>
            <span>Attendance workspace</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "nav-link active" : "nav-link"}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <SyncIndicator />
          <span className="account-email">{user?.email}</span>
          <button className="button subtle full" type="button" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </aside>
      <div className="content-column">
        <header className="topbar">
          <div className="mobile-brand">Abundant Life UPC</div>
          <SyncIndicator />
        </header>
        <main className="page-content">
          <SyncBanner />
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={pathname === item.href ? "mobile-nav-link active" : "mobile-nav-link"}
            aria-current={pathname === item.href ? "page" : undefined}
          >
            <span aria-hidden="true">{item.glyph}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
