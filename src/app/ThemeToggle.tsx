"use client";

import { useEffect, useState } from "react";
import { Icons } from "./ui";

// Discreet light/dark switch. Two states only (sun ↔ moon). The effective theme
// lives as a data-theme attribute on <html>: the pre-paint inline script in
// layout.tsx seeds it (persisted choice, else the OS preference) so there's no
// flash, and this button keeps it — plus localStorage — in lockstep at runtime.
// While the user hasn't made an explicit choice, we keep following the OS.

type Theme = "light" | "dark";
const KEY = "winnow.theme";

function apply(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export default function ThemeToggle() {
  // Server and first client render assume "light" (the default palette) so the
  // markup matches; the effect below reconciles to whatever the inline script
  // already stamped on <html>, without a hydration mismatch.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current =
      (document.documentElement.getAttribute("data-theme") as Theme | null) ??
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    setTheme(current);

    // No explicit choice yet → track the OS preference live.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      /* storage disabled */
    }
    if (stored === "light" || stored === "dark") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      const next: Theme = e.matches ? "dark" : "light";
      setTheme(next);
      apply(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage disabled: non-persisted for this session */
    }
  };

  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className="icon-toggle theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={dark}
      title={dark ? "Light theme" : "Dark theme"}
    >
      {dark ? Icons.sun : Icons.moon}
    </button>
  );
}
