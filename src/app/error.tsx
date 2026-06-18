"use client";

// Error boundary segment-level : une exception de rendu dans une page n'efface
// plus toute l'app — on affiche un fallback récupérable.
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
