"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icons } from "./ui";

/**
 * The one header band a section wears (UI review S1/S3): the page's name, the
 * section's tabs beside it, and whatever trails — a count, a notice — at the
 * far end. It replaces the pair every page used to type by hand: a `.topbar`
 * (title + strapline) stacked over a `.shell-head` (the tabs), two bands and
 * 116px before the first pixel of content, three once the view's own toolbar
 * followed.
 *
 * With `back` it is a detail page's header: the chevron first, the entity's
 * name as the h1 (a session, a person, a deck). The three drill-in pages used
 * to disagree on both (S4). A detail page may add a `subtitle` under the name
 * — one line of facts about the entity ("14 Jun 2026 · Sony A7C II · 14
 * files" and the chips that carry a state) — and its `trailing` slot holds the
 * page's primary verb and the `⋯` menu (H2/H5): the header is then ~64px, the
 * whole of what a session page used to spread over a 400px card.
 *
 * What it does not carry, on purpose: the strapline ("media triage — organize
 * & review") described the app to the person already using it; and the second
 * band — a view's toolbar (the gallery controls, the heatmap pickers, the
 * search bar) stays the page's own, rendered right under this.
 *
 * On a phone the title keeps the first line to itself, exactly the height of
 * the fixed theme-toggle/account corner it must clear (`.rail-foot`, 3.6rem),
 * the subtitle follows under it, and the tabs and the trailing content take a
 * line of their own where the tabs scroll (cf. the phone rules in globals.css).
 */
export default function PageHeader({
  title,
  subtitle,
  back,
  backLabel = "Back",
  tabs,
  trailing,
  className,
}: {
  title: ReactNode;
  /** One line of facts under the title, on a detail page. */
  subtitle?: ReactNode;
  /** Href of the parent list; renders the leading chevron. */
  back?: string;
  backLabel?: string;
  /** The section's tabs (a `.tabs` nav), beside the title. */
  tabs?: ReactNode;
  /** A count, a notice, an action — pushed to the far end. */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("page-head", className)}>
      {back && (
        <Link
          href={back}
          className="btn btn-icon page-back"
          aria-label={backLabel}
        >
          {Icons.back}
        </Link>
      )}
      <div className="page-heading">
        <h1 className="page-title">
          <span className="page-title-text">{title}</span>
        </h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {tabs && <div className="page-tabs">{tabs}</div>}
      {trailing && <div className="page-trailing">{trailing}</div>}
    </header>
  );
}
