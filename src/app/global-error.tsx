"use client";

// Root safety net: catches errors occurring in the layout itself.
// Must render its own <html>/<body> (it replaces the root layout).
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
