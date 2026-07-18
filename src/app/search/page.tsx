"use client";

// Semantic search surface: type a description in natural language and rank the
// library by CLIP cosine similarity (GET /api/search, cf. lib/ml.ts). Results
// render as a simple thumbnail grid; each opens the full proxy. Depends on ML
// being enabled and a CLIP back-fill having run (npm run ml-backfill).
import { useState } from "react";
import { Icons } from "../ui";

type Item = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  distance: number;
};

type State = "idle" | "loading" | "error" | "disabled";

const EXAMPLES = [
  "sunset over the sea",
  "people laughing at a table",
  "close-up of a bird",
  "snowy mountain landscape",
];

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");

  async function run(query: string) {
    const text = query.trim();
    if (!text) return;
    setState("loading");
    setMsg("");
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(text)}&limit=80`,
      );
      const data = await res.json();
      if (data?.enabled === false) {
        setItems([]);
        setState("disabled");
        return;
      }
      if (!res.ok) {
        setState("error");
        setMsg(data?.detail || data?.error || "Search failed");
        return;
      }
      setItems(data.items ?? []);
      setState("idle");
    } catch (err) {
      setState("error");
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="search-page">
      <h1 className="search-title">Search</h1>
      <p className="hint">
        Describe what you’re looking for in plain language — winnow ranks the
        library by visual similarity (CLIP).
      </p>

      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          run(q);
        }}
      >
        <span className="search-icon" aria-hidden>
          {Icons.search}
        </span>
        <input
          className="input search-input"
          type="search"
          placeholder="a red bicycle against a wall…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button className="btn btn-primary" type="submit" disabled={!q.trim()}>
          Search
        </button>
      </form>

      <div className="search-examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            className="chip"
            onClick={() => {
              setQ(ex);
              run(ex);
            }}
          >
            {ex}
          </button>
        ))}
      </div>

      {state === "loading" && <div className="spinner">Searching…</div>}

      {state === "disabled" && (
        <div className="empty-state">
          Semantic search is off. It needs (1) <strong>pgvector</strong> — the
          compose Postgres image (<code>pgvector/pgvector:pg16</code>) provides
          it; a stock <code>postgres:16-alpine</code> does not — and (2) ML on:{" "}
          <code>ML_ENABLED=true</code>, <code>ML_CLIP_ENABLED=true</code>, with{" "}
          <code>ML_BASE_URL</code> pointing at your immich-machine-learning
          container. Then back-fill embeddings with{" "}
          <code>npm run ml-backfill -- --force</code>.
        </div>
      )}

      {state === "error" && (
        <div className="empty-state error">Search failed: {msg}</div>
      )}

      {state === "idle" && items && items.length === 0 && (
        <div className="empty-state">
          No matches. Try a broader description — or check that a CLIP back-fill
          has run.
        </div>
      )}

      {items && items.length > 0 && (
        <div className="search-grid">
          {items.map((it) => (
            <a
              key={it.id}
              href={`/api/assets/${it.id}/proxy`}
              target="_blank"
              rel="noreferrer"
              className="search-cell"
              title={`${it.filename} · ${(1 - it.distance).toFixed(2)}`}
            >
              <img
                src={`/api/assets/${it.id}/thumb`}
                alt={it.filename}
                loading="lazy"
              />
              {it.media_type === "video" && (
                <span className="search-badge">▶</span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
