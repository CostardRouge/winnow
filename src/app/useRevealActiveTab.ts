"use client";

import { useEffect, type RefObject } from "react";

// A tab bar that scrolls sideways on a phone (`.tabs` and `.pipeline-tabs`
// under 768px, cf. globals.css) can mount with its active tab out of view:
// landing on /settings/database showed "Pipeline · Features · Volumes · Import"
// and nothing to say the current section was the one hidden past the edge.
// Reveal it once per route change (and whenever the tab list itself changes,
// which the caller folds into `key`). `block: "nearest"` keeps the page's own
// scroll position untouched — only the pill scrolls, and only if it has to.
export function useRevealActiveTab(
  ref: RefObject<HTMLElement | null>,
  key: string,
) {
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(".active");
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ref, key]);
}
