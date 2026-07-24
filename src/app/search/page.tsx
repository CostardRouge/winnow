"use client";

// Semantic search surface: type a description in natural language and rank the
// library by CLIP cosine similarity (GET /api/search, cf. lib/ml.ts). Results
// render as a simple thumbnail grid; each opens in the shared MediaViewer.
// Depends on ML being enabled and the library being indexed — the coverage
// line under the results says how much of it actually is.
import { useState } from "react";
import Link from "next/link";
import { Icons } from "../ui";
import MediaViewer from "../MediaViewer";

type Item = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  distance: number;
};

// How much of the library the ranking actually ran over (cf. api/search): a
// partially filled index is THE reason different queries return the same few
// images, so the page always says what it searched.
type Coverage = { indexed: number; library: number };

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
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

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
      setCoverage(
        typeof data.indexed === "number" && typeof data.library === "number"
          ? { indexed: data.indexed, library: data.library }
          : null,
      );
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
          Semantic search is off. Set <code>ML_ENABLED=true</code> and{" "}
          <code>ML_CLIP_ENABLED=true</code>, point <code>ML_BASE_URL</code> at
          your immich-machine-learning container, then back-fill embeddings with{" "}
          <code>npm run ml-backfill</code>.
        </div>
      )}

      {state === "error" && (
        <div className="empty-state error">Search failed: {msg}</div>
      )}

      {state === "idle" &&
        items &&
        items.length === 0 &&
        (coverage?.indexed === 0 ? (
          <div className="empty-state">
            Nothing is indexed for search yet. Run{" "}
            <Link href="/pipeline">“Index for search” on the Pipeline page</Link>{" "}
            (or <code>npm run ml-backfill</code>) and let the worker drain the
            queue.
          </div>
        ) : (
          <div className="empty-state">
            No matches. Try a broader description — or check that a CLIP
            back-fill has run.
          </div>
        ))}

      {items && items.length > 0 && (
        <div className="search-grid">
          {items.map((it, idx) => (
            <button
              key={it.id}
              type="button"
              className="search-cell"
              title={`${it.filename} · ${(1 - it.distance).toFixed(2)}`}
              onClick={() => setViewer(idx)}
            >
              <img
                src={`/api/assets/${it.id}/thumb`}
                alt={it.filename}
                loading="lazy"
              />
              {it.media_type === "video" && (
                <span className="search-badge">▶</span>
              )}
            </button>
          ))}
        </div>
      )}

      {state === "idle" && items && coverage && coverage.indexed > 0 && (
        <p className="hint search-coverage">
          Searched {coverage.indexed.toLocaleString()} of{" "}
          {coverage.library.toLocaleString()} media
          {coverage.indexed < coverage.library && (
            <>
              {" "}
              — the rest aren’t indexed yet.{" "}
              <Link href="/pipeline">Index for search →</Link>
            </>
          )}
        </p>
      )}

      {viewer != null && items?.[viewer] && (
        <MediaViewer
          items={items}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          renderActions={(it) => (
            <a className="btn" href={`/api/assets/${it.id}/download`} download>
              Download
            </a>
          )}
        />
      )}
    </div>
  );
}
