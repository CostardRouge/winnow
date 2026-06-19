"use client";

// Centralized list of what has failed (scan / analyze / import), with the
// error message for debugging, and a "retry" button per family.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";

type DerivItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  error: string | null;
  updated_at: string;
};
type ScanItem = {
  abs_path: string;
  error: string;
  attempts: number;
  updated_at: string;
};
type ImportItem = {
  batch_id: number;
  origin: string | null;
  file: string;
  error: string;
  created_at: string;
};
type DuplicateItem = {
  abs_path: string;
  content_hash: string;
  existing_asset_id: number | null;
  source: string;
  verified: boolean | null;
  hits: number;
  updated_at: string;
};
type Failures = {
  derivative: { count: number; items: DerivItem[] };
  scan: { count: number; items: ScanItem[] };
  import: { count: number; items: ImportItem[] };
  duplicates: {
    count: number;
    falseCollisions: number;
    items: DuplicateItem[];
  };
};

type Kind = "derivative" | "scan" | "import";

export default function FailuresPage() {
  const [data, setData] = useState<Failures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [msg, setMsg] = useState<string>("");

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Failures>("/api/failures"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function retry(kind: Kind) {
    setBusy(kind);
    setMsg("");
    try {
      const r = await fetch("/api/failures/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const d = await r.json();
      setMsg(
        r.ok
          ? `Re-queued ${kind} (${d.retried ?? 0}). Watch the counts drop as it reprocesses.`
          : `Error: ${d.error ?? "unknown"}`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="topbar">
        <Link href="/" className="btn">
          ←
        </Link>
        <h1>Failures</h1>
        <span className="spacer" />
        <button className="btn" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="container">
        {error && (
          <div className="error-box">
            <span>Couldn’t load failures: {error}</span>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {msg && <p className="hint">{msg}</p>}

        <Section
          title="Analyze (derivatives)"
          hint="Photo/video derivative generation failed — check the message, fix the cause (e.g. ffmpeg/codec), then retry."
          count={data?.derivative.count ?? 0}
          onRetry={() => retry("derivative")}
          busy={busy === "derivative"}
          retryLabel="Retry all"
        >
          {(data?.derivative.items ?? []).map((it) => (
            <FailRow
              key={`d${it.asset_id}`}
              title={`#${it.asset_id} · ${it.filename} (${it.media_type})`}
              path={it.abs_path}
              error={it.error ?? "—"}
              when={it.updated_at}
            />
          ))}
        </Section>

        <Section
          title="Scan (indexing)"
          hint="Files that couldn’t be indexed (unreadable, corrupt, metadata error). Retry re-scans the roots."
          count={data?.scan.count ?? 0}
          onRetry={() => retry("scan")}
          busy={busy === "scan"}
          retryLabel="Retry scans"
        >
          {(data?.scan.items ?? []).map((it) => (
            <FailRow
              key={`s${it.abs_path}`}
              title={it.abs_path}
              error={it.error}
              when={it.updated_at}
              badge={`${it.attempts}×`}
            />
          ))}
        </Section>

        <Section
          title="Import"
          hint="Files that failed verification/filing. Failed files are quarantined in the inbox’s .failed/ folder; retry re-imports them."
          count={data?.import.count ?? 0}
          onRetry={() => retry("import")}
          busy={busy === "import"}
          retryLabel="Retry quarantine"
        >
          {(data?.import.items ?? []).map((it, i) => (
            <FailRow
              key={`i${it.batch_id}-${i}`}
              title={it.file}
              error={it.error}
              when={it.created_at}
              badge={it.origin ?? undefined}
            />
          ))}
        </Section>

        <Section
          title="Deduplication"
          hint={`Files matched as duplicates by partial hash. False collisions (genuinely distinct content) are indexed anyway — never dropped — and flagged here for audit.${
            data && data.duplicates.falseCollisions > 0
              ? ` ${data.duplicates.falseCollisions} false collision(s) recovered.`
              : ""
          }`}
          count={data?.duplicates.count ?? 0}
        >
          {(data?.duplicates.items ?? []).map((it, i) => (
            <FailRow
              key={`u${it.abs_path}-${i}`}
              title={it.abs_path}
              error={`${it.source} · ${
                it.verified === false
                  ? "FALSE collision → indexed separately (kept)"
                  : it.verified === true
                    ? "confirmed duplicate (not reprocessed)"
                    : "unverified (existing file unreadable) — treated as duplicate"
              }${
                it.existing_asset_id ? ` · matched asset #${it.existing_asset_id}` : ""
              } · ${it.content_hash.slice(0, 12)}…`}
              when={it.updated_at}
              badge={
                it.verified === false
                  ? "false collision"
                  : it.hits > 1
                    ? `${it.hits}×`
                    : undefined
              }
            />
          ))}
        </Section>
      </div>
    </>
  );
}

function Section({
  title,
  hint,
  count,
  onRetry,
  busy,
  retryLabel,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  onRetry?: () => void;
  busy?: boolean;
  retryLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>
          {title} <span className="hint">({count})</span>
        </h3>
        <span className="spacer" />
        {onRetry && (
          <button
            className="btn"
            onClick={onRetry}
            disabled={busy || count === 0}
          >
            {busy ? "…" : retryLabel}
          </button>
        )}
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {hint}
      </p>
      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : (
        <div className="fail-list">{children}</div>
      )}
    </section>
  );
}

function FailRow({
  title,
  path,
  error,
  when,
  badge,
}: {
  title: string;
  path?: string;
  error: string;
  when: string;
  badge?: string;
}) {
  return (
    <div className="fail-row">
      <div className="fail-head">
        <strong className="fail-title">{title}</strong>
        {badge && <span className="pill">{badge}</span>}
        <span className="spacer" />
        <span className="fail-when">
          {(() => {
            try {
              return new Date(when).toLocaleString("en-GB");
            } catch {
              return when;
            }
          })()}
        </span>
      </div>
      {path && path !== title && <div className="fail-path">{path}</div>}
      <div className="fail-err">{error}</div>
    </div>
  );
}
