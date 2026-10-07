"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Application shell: a sidebar on desktop, a compact top bar on small screens. Links are client-side navigations, so
// the current analysis (held in the browser's analysis store) survives moving between pages.

const NAV = [
  { href: "/", label: "Analyze", icon: "analyze" },
  { href: "/evaluation", label: "Evaluation", icon: "evaluation", tag: "internal" },
] as const;

function Icon({ name }: { name: "analyze" | "evaluation" | "settings" }) {
  const paths: Record<typeof name, ReactNode> = {
    analyze: (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
      </>
    ),
    evaluation: (
      <>
        <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>
    ),
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const isCurrent = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <img className="brand-logo" src="/icon-192.png" alt="" width={32} height={32} />
          <span className="brand-text">
            <span className="brand-name">Audience Reaction</span>
            <span className="brand-tag">Local prototype</span>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={isCurrent(item.href) ? "page" : undefined}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {"tag" in item && <span className="nav-tag">{item.tag}</span>}
            </Link>
          ))}
        </nav>
        <nav className="nav nav-bottom" aria-label="Settings">
          <Link href="/settings" className="nav-link" aria-current={isCurrent("/settings") ? "page" : undefined}>
            <Icon name="settings" />
            <span>Settings</span>
            <span className="nav-sub">API &amp; models</span>
          </Link>
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
