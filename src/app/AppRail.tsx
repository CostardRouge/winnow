"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Brand, Icons } from "./ui";
import ThemeToggle from "./ThemeToggle";
import ChangePasswordModal from "./ChangePasswordModal";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Persistent navigation rail: vertical on desktop (left edge), a bottom tab bar
// on phones. The single source of app navigation — pages no longer carry their
// own back-arrows. "Library" owns the home dashboard and every session drill-in.
type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: "/library",
    label: "Library",
    icon: Icons.library,
    match: (p) => p === "/" || p.startsWith("/library") || p.startsWith("/sessions"),
  },
  {
    href: "/sift",
    label: "Sift",
    icon: Icons.sift,
    match: (p) => p.startsWith("/sift"),
  },
  {
    href: "/search",
    label: "ML search",
    icon: Icons.search,
    match: (p) => p.startsWith("/search"),
  },
  {
    href: "/gear",
    label: "Gear",
    icon: Icons.gear,
    match: (p) => p.startsWith("/gear"),
  },
  {
    href: "/import",
    label: "Import",
    icon: Icons.inbox,
    match: (p) => p.startsWith("/import"),
  },
  {
    href: "/volumes",
    label: "Volumes",
    icon: Icons.volumes,
    match: (p) => p.startsWith("/volumes"),
  },
  {
    href: "/pipeline",
    label: "Pipeline",
    icon: Icons.pipeline,
    // Failures now lives under /pipeline, so the rail entry covers it too.
    match: (p) => p.startsWith("/pipeline"),
  },
];

type Me = {
  id: number;
  username: string;
  displayName: string | null;
  role: "admin" | "editor" | "viewer";
};

// The signed-in account, foot of the rail: an initial chip that opens a small
// popover (who am I, role, Users management for admins, sign out).
function AccountChip() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.user) setMe(d.user as Me);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Close on any click outside the chip/popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!me) return null;

  const name = me.displayName?.trim() || me.username;
  const initial = name.charAt(0).toUpperCase();

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="account-wrap" ref={wrapRef}>
      <button
        type="button"
        className="account-btn"
        title={`${name} (${me.role})`}
        aria-label={`Account: ${name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {initial}
      </button>
      {open && (
        <div className="account-pop" role="menu">
          <div className="account-id">
            <span className="account-name">{name}</span>
            <span className="account-role">{me.role}</span>
          </div>
          {me.role === "admin" && (
            <Link
              href="/users"
              className="account-item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <span className="account-item-ic" aria-hidden>
                {Icons.users}
              </span>
              Users
            </Link>
          )}
          <button
            type="button"
            className="account-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setChangingPassword(true);
            }}
          >
            <span className="account-item-ic" aria-hidden>
              {Icons.key}
            </span>
            Change password
          </button>
          <button
            type="button"
            className="account-item"
            role="menuitem"
            onClick={signOut}
          >
            <span className="account-item-ic" aria-hidden>
              {Icons.signout}
            </span>
            Sign out
          </button>
        </div>
      )}
      {changingPassword && (
        <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      )}
    </div>
  );
}

export default function AppRail() {
  const pathname = usePathname() ?? "/";

  // The login and invite screens stand alone — no navigation chrome around
  // them (an invitee is not signed in yet).
  if (pathname === "/login" || pathname.startsWith("/invite/")) return null;

  return (
    <nav className="rail" aria-label="Primary">
      <Link href="/library" className="rail-brand" aria-label="Winnow — home">
        <Brand compact />
      </Link>
      <div className="rail-nav">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rail-link${item.match(pathname) ? " active" : ""}`}
            aria-current={item.match(pathname) ? "page" : undefined}
          >
            <span className="rail-ic" aria-hidden>
              {item.icon}
            </span>
            <span className="rail-label">{item.label}</span>
          </Link>
        ))}
      </div>
      <div className="rail-foot">
        <AccountChip />
        <ThemeToggle />
      </div>
    </nav>
  );
}
