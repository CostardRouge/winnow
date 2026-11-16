"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AccountMenu } from "./AccountMenu";
import { Brand, ConfirmDialog, Icons } from "./ui";
import ThemeToggle from "./ThemeToggle";
import ChangePasswordModal from "./ChangePasswordModal";
import { useFeatures } from "./FeaturesProvider";
import type { FeatureId } from "@/lib/features";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Persistent navigation rail: vertical on desktop (left edge), a bottom tab bar
// on phones. The single source of app navigation — pages no longer carry their
// own back-arrows. "Library" owns the home dashboard and every session drill-in.
//
// Every entry but Library carries a `feature` id: the rail is the scarcest
// surface in the app, and an instance decides in Settings › Features which of
// the optional sections it wants to see. A hidden entry is not merely absent
// from the rail — its route 404s (cf. src/lib/features.ts).
type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
  /** Absent on Library: the one section that is always offered. */
  feature?: FeatureId;
};

const NAV: NavItem[] = [
  {
    href: "/library",
    label: "Library",
    icon: Icons.library,
    match: (p) => p === "/" || p.startsWith("/library") || p.startsWith("/sessions"),
  },
  {
    // The library read as a story — chapters across session folders. Second
    // in the rail because it is a way INTO the library, not a tool on it.
    href: "/timeline",
    label: "Timeline",
    icon: Icons.timeline,
    match: (p) => p.startsWith("/timeline"),
    feature: "timeline",
  },
  {
    // Also a way INTO the library rather than a tool on it, so it sits beside
    // the Timeline rather than inside the Library section — and its toolbar
    // (select, density, Incoming/Gallery) means nothing to a distribution.
    href: "/heatmap",
    label: "Heatmap",
    icon: Icons.heatmap,
    match: (p) => p.startsWith("/heatmap"),
    feature: "heatmap",
  },
  {
    href: "/sift",
    label: "Sift",
    icon: Icons.sift,
    match: (p) => p.startsWith("/sift"),
    feature: "sift",
  },
  {
    href: "/search",
    label: "Search",
    icon: Icons.search,
    match: (p) => p.startsWith("/search"),
    feature: "search",
  },
  {
    href: "/people",
    label: "People",
    icon: Icons.people,
    match: (p) => p.startsWith("/people"),
    feature: "people",
  },
  {
    href: "/gear",
    label: "Gear",
    icon: Icons.gear,
    match: (p) => p.startsWith("/gear"),
    feature: "gear",
  },
];
// Pipeline, Volumes and Import used to sit here too. They're configuration
// rather than day-to-day work, so they moved into the Settings section (reached
// from the account popover below) and the rail keeps only the places you
// actually spend time. The pipeline triage lists now live under
// /settings/pipeline/* and are still deep-linked from the counters bento and
// the Library stats strip.

type Me = {
  id: number;
  username: string;
  displayName: string | null;
  role: "admin" | "editor" | "viewer";
  via?: string | null;
  // null: this instance has no Sésame; else whether the account is linked.
  sesame?: { linked: boolean } | null;
};

// The signed-in account, foot of the rail: an initial chip that opens a small
// popover (AccountMenu: the places, how you sign in, sign out).
function AccountChip({ version }: { version: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
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

  // Back from linking Sésame (?sesame=linked|taken, api/auth/sesame/callback):
  // say a refusal once, then drop the parameter from the address.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("sesame");
    if (outcome !== "linked" && outcome !== "taken") return;
    if (outcome === "taken")
      window.alert("This Sésame identity is already linked to another Winnow account.");
    url.searchParams.delete("sesame");
    window.history.replaceState(null, "", url.toString());
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

  async function unlinkSesame() {
    setUnlinking(true);
    try {
      const r = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sesame: null }),
      });
      if (r.ok) setMe({ ...me!, sesame: { linked: false } });
    } finally {
      setUnlinking(false);
      setConfirmingUnlink(false);
    }
  }

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
        <AccountMenu
          user={{
            name,
            role: me.role,
            // Not through an app token: a token cannot link nor unlink (api/auth/me).
            sesame: me.sesame && me.via !== "token" && me.via !== "agent" ? me.sesame : null,
          }}
          version={version}
          linkHref={`/api/auth/sesame/login?intent=link&next=${encodeURIComponent(pathname || "/library")}`}
          onNavigate={() => setOpen(false)}
          onChangePassword={() => {
            setOpen(false);
            setChangingPassword(true);
          }}
          onSesameLinked={() => {
            setOpen(false);
            setConfirmingUnlink(true);
          }}
          onSignOut={signOut}
        />
      )}
      <ConfirmDialog
        open={confirmingUnlink}
        title="Sésame is linked"
        message={
          <p>
            You can sign in to Winnow with your Sésame passkey. Unlinking leaves your password as the
            only way in; you can link Sésame again from this menu.
          </p>
        }
        confirmLabel="Unlink Sésame"
        cancelLabel="Keep it linked"
        danger
        busy={unlinking}
        onConfirm={unlinkSesame}
        onCancel={() => setConfirmingUnlink(false)}
      />
      {changingPassword && (
        <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      )}
    </div>
  );
}

/**
 * `version` comes down from the root layout, a server component, as a plain
 * string: importing `@/lib/version` here would put the whole package.json —
 * every dependency — into a client chunk, since the bundler does not narrow a
 * JSON import to the one key a client component reads.
 */
export default function AppRail({ version }: { version: string }) {
  const pathname = usePathname() ?? "/";
  const features = useFeatures();

  // Library always; every other entry only while its feature is on. The flags
  // come from the server through the root layout, so the rail is right on the
  // first paint — an entry that appears a beat later reads as a glitch.
  const nav = useMemo(
    () => NAV.filter((item) => !item.feature || features[item.feature]),
    [features],
  );

  // The login and invite screens stand alone — no navigation chrome around
  // them (an invitee is not signed in yet).
  if (pathname === "/login" || pathname.startsWith("/invite/")) return null;

  return (
    <nav className="rail" aria-label="Primary">
      <Link href="/library" className="rail-brand" aria-label="Winnow — home">
        <Brand compact />
      </Link>
      <div className="rail-nav">
        {nav.map((item) => (
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
      {/* Theme switch first, account chip last — the account is the end of the
          rail on desktop and the right-most chip in the phone header. */}
      <div className="rail-foot">
        <ThemeToggle />
        <AccountChip version={version} />
      </div>
    </nav>
  );
}
