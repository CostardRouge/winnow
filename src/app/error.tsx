"use client";

// Segment-level error boundary: a render exception in a page no longer
// wipes out the whole app — we show a recoverable fallback.
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Render error:", error);
  }, [error]);

  return (
    <div className="error-page">
      <h2>Something went wrong</h2>
      <p className="hint">{error.message || "Unexpected error."}</p>
      <button className="btn btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
