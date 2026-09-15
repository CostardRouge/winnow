"use client";

// Root safety net: catches errors occurring in the layout itself.
// Must render its own <html>/<body> (it replaces the root layout) — which
// also means nothing the layout provides is here: no stylesheet, no font
// variables, no theme attribute. The stylesheet is imported below so the page
// wears the Paper system like error.tsx does (its button used to be the bare
// browser default — UI review P4); the fonts fall back to the stacks
// globals.css declares; the theme is resolved by the same pre-paint script
// the layout runs, so a night-paper user does not get a flash of light paper
// on the one screen that already means something went wrong.
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Fatal error:", error);
  }, [error]);

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Keep in sync with the theme script in layout.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("winnow.theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){}`,
          }}
        />
        <div className="error-page">
          <h2>Something went wrong</h2>
          <p className="hint">{error.message || "Unexpected error."}</p>
          <button className="btn btn-primary" onClick={reset}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
