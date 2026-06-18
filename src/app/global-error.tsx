"use client";

// Filet racine : capture les erreurs survenant dans le layout lui-même.
// Doit rendre ses propres <html>/<body> (il remplace le layout racine).
import { useEffect } from "react";

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
    <html lang="en">
      <body>
        <div className="error-page">
          <h2>Something went wrong</h2>
          <p>{error.message || "Unexpected error."}</p>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
