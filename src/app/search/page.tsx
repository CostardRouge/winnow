"use client";

// Semantic search surface: type a description in natural language and rank the
// library by CLIP cosine similarity (GET /api/search, cf. lib/ml.ts).
//
// The page wears the section chrome every other surface wears — topbar, a
// controls band, then a full-bleed body — and renders its results through the
// gallery's own VirtualGrid, so a hit tile is the same tile it is on Library
// (same size, badges, verdict edge, Live Photo hover). Depends on ML being
// enabled and the library being indexed — the coverage readout in the controls
// band says how much of it actually is.
//
// The query lives in the query string (`/search?keywords=…`), the way filters do
// on Library and Incoming: a search is then shareable, reload-safe, and a deep
// link from anywhere else lands on results rather than on an empty field.
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { EmptyState, Icons, LoadingState } from "../ui";
import MediaViewer from "../MediaViewer";
import VirtualGrid, { type VirtualGridHandle } from "../gallery/VirtualGrid";
import type { AssetGridRow } from "@/lib/types";

// The API returns the usual grid rows plus the cosine distance it ranked by.
type Item = AssetGridRow & { distance: number };

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

const LIMIT = 120;

// The query-string key the page reads and writes: /search?keywords=a+red+bicycle
const PARAM = "keywords";

function SearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Seeded from the URL once; the page owns the parameter thereafter and
  // mirrors each run back into it.
  const [initial] = useState(() => (searchParams.get(PARAM) ?? "").trim());
  const [q, setQ] = useState(initial);
  // The query the current results answer — the controls band reports on this,
  // not on whatever is being typed into the field.
  const [ran, setRan] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState("");
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const gridRef = useRef<VirtualGridHandle>(null);

  const run = useCallback(
    async (query: string) => {
      const text = query.trim();
      if (!text) return;
      setState("loading");
      setMsg("");
      setRan(text);
      // Replace, not push: Back steps out of the page rather than through every
      // query that was tried (same rule as the gallery's filters).
      try {
        const sp = new URLSearchParams(window.location.search);
        sp.set(PARAM, text);
        router.replace(`/search?${sp.toString()}`, { scroll: false });
      } catch {
        /* non-fatal: the results below are what matter */
      }
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(text)}&limit=${LIMIT}`,
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
    },
    [router],
  );

  // A URL that arrived with ?keywords= searches on its own — once. The page
  // writes that parameter itself from then on, so this must not re-fire.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !initial) return;
    seeded.current = true;
    run(initial);
  }, [initial, run]);

  // The result zone: one of the states, or the grid. Kept in a variable so the
  // shell below reads as the layout it is.
  const body = () => {
    if (state === "loading") return <LoadingState label="Searching…" />;

    if (state === "disabled")
      return (
        <EmptyState
          icon={Icons.photoSearch}
          title="Semantic search is off"
          hint="It needs a vector-capable database and CLIP turned on before the library can be ranked by description."
        >
          <div className="ml-search-setup">
            <p>
              <strong>1 · pgvector.</strong> The compose Postgres image (
              <code>pgvector/pgvector:pg16</code>) provides it; a stock{" "}
              <code>postgres:16-alpine</code> does not.
            </p>
            <p>
              <strong>2 · ML on.</strong> <code>ML_ENABLED=true</code>,{" "}
              <code>ML_CLIP_ENABLED=true</code>, with <code>ML_BASE_URL</code>{" "}
              pointing at your immich-machine-learning container.
            </p>
            <p>
              <strong>3 · Back-fill.</strong>{" "}
              <code>npm run ml-backfill -- --force</code>, then let the worker
              drain the queue.
            </p>
          </div>
        </EmptyState>
      );

    if (state === "error")
      return (
        <EmptyState icon={Icons.alert} title="Search failed" hint={msg}>
          <button className="btn" onClick={() => run(ran)}>
            Retry
          </button>
        </EmptyState>
      );

    if (!items)
      return (
        <EmptyState
          icon={Icons.photoSearch}
          title="Describe what you’re looking for"
          hint="Plain language works best — winnow ranks the library by visual similarity (CLIP), not by filename or tag."
        />
      );

    if (items.length === 0 && coverage?.indexed === 0)
      return (
        <EmptyState
          icon={Icons.photoSearch}
          title="Nothing is indexed for search yet"
          hint="CLIP embeddings have to exist before anything can be ranked."
        >
          <Link className="btn btn-primary" href="/settings/pipeline">
            Index for search
          </Link>
        </EmptyState>
      );

    if (items.length === 0)
      return (
        <EmptyState
          icon={Icons.photoSearch}
          title="No matches"
          hint="Try a broader description — or check that a CLIP back-fill has run over the whole library."
        />
      );

    return (
      <VirtualGrid
        ref={gridRef}
        items={items}
        hasMore={false}
        loading={false}
        loadMore={() => {}}
        onOpen={setViewer}
      />
    );
  };

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Search</h1>
        <span className="hint max-sm:hidden">
          semantic — describe it, CLIP ranks the library
        </span>
      </div>

      <div className="shell-head">
        <form
          className="ml-search-bar"
          onSubmit={(e) => {
            e.preventDefault();
            run(q);
          }}
        >
          <div className="search-field">
            <span className="search-icon" aria-hidden>
              {Icons.search}
            </span>
            <input
              className="input search-input"
              type="search"
              placeholder="a red bicycle against a wall…"
              aria-label="Describe what you’re looking for"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
            {q && (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear the query"
                onClick={() => setQ("")}
              >
                ×
              </button>
            )}
          </div>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!q.trim() || state === "loading"}
          >
            Search
          </button>
        </form>
      </div>

      {/* Same band the gallery uses for its view controls: example queries on
          the left, what the last run actually covered on the right — so a
          thin index is visible above the results rather than under them. */}
      <div className="gallery-controls ml-search-controls">
        <span className="hint ml-search-label">Try</span>
        <div className="ml-search-examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className={`chip${ran === ex ? " active" : ""}`}
              onClick={() => {
                setQ(ex);
                run(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {state === "idle" && items && items.length > 0 && (
          <span className="hint ml-search-readout">
            {items.length === LIMIT
              ? `top ${LIMIT}`
              : `${items.length} ${items.length === 1 ? "match" : "matches"}`}
            {coverage && coverage.indexed > 0 && (
              <>
                {" · "}
                searched {coverage.indexed.toLocaleString()} of{" "}
                {coverage.library.toLocaleString()}
                {coverage.indexed < coverage.library && (
                  <>
                    {" — "}
                    <Link href="/settings/pipeline">index the rest →</Link>
                  </>
                )}
              </>
            )}
          </span>
        )}
      </div>

      <div className="ml-search-body">{body()}</div>

      {viewer != null && items?.[viewer] && (
        <MediaViewer
          items={items}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => {
            // Land the grid on the media we were viewing, exactly as the
            // gallery does when its viewer closes.
            gridRef.current?.scrollToIndex(viewer);
            setViewer(null);
          }}
          renderInfo={(it) => (
            <div className="viewer-tags">
              <span
                className="chip"
                title="CLIP cosine similarity to the query"
              >
                similarity {(1 - it.distance).toFixed(3)}
              </span>
            </div>
          )}
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

export default function SearchPageRoute() {
  // Suspense: the page reads useSearchParams, which opts the route out of
  // static prerendering unless the read sits behind a boundary.
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
