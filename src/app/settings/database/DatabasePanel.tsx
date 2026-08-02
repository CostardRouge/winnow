"use client";

// Database observability + backup surface (Settings › Database).
//
// Three answers on one page:
//   1. "What does the library actually weigh in Postgres?" — a per-table size
//      table with the heap/TOAST/index split, sorted heaviest-first. TOAST is
//      where the big values (face-embedding JSONB, OCR text) really live, so
//      the split shows WHY a table is heavy, not just that it is.
//   2. "Which columns are eating the space?" — exact on-disk weight of the
//      known-heavy columns (face/CLIP embeddings, OCR text), because a row
//      count alone never reveals that 200k embeddings cost gigabytes.
//   3. "Can I take a safety copy right now?" — a fresh streamed pg_dump
//      (admin), plus the scheduled sidecar dumps when their dir is mounted.
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import PullToRefresh from "@/app/PullToRefresh";
import { Icons } from "@/app/ui";

type DbStats = {
  database: {
    sizeBytes: number;
    serverVersion: string;
    pgvector: boolean;
    migrations: { count: number; last: string | null };
  };
  tables: {
    name: string;
    approxRows: number;
    totalBytes: number;
    heapBytes: number;
    toastBytes: number;
    indexBytes: number;
  }[];
  heavyColumns: {
    table: string;
    column: string;
    label: string;
    rows: number;
    bytes: number;
  }[];
  backups: {
    dir: string;
    mounted: boolean;
    files: { name: string; bytes: number; mtime: string }[];
  };
  dump: {
    available: boolean;
    clientMajor: number | null;
    serverMajor: number;
    reason: string | null;
  };
};

type Me = { role: "admin" | "editor" | "viewer" };

function fmtRows(n: number): string {
  return n < 0 ? "—" : n.toLocaleString("en-GB");
}

export default function DatabasePanel() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<DbStats>("/api/db/stats");
      setStats(data);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe((d?.user as Me) ?? null))
      .catch(() => {});
  }, [load]);

  const isAdmin = me?.role === "admin";
  const db = stats?.database;
  const faces = stats?.heavyColumns.find((h) => h.table === "asset_faces");
  const clip = stats?.heavyColumns.find((h) => h.table === "asset_clip");
  const largest = stats?.tables[0];

  return (
    <PullToRefresh onRefresh={load}>
      <div className="filterbar">
        <p className="hint" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          What Postgres holds for this library — the one piece of state that
          isn’t regenerable. Check the weight, take a dump before risky work,
          compare after. Restore runbook: <code>docs/BACKUP.md</code>.
        </p>
        {isAdmin &&
          (stats?.dump.available === false ? (
            <button
              className="btn btn-primary"
              disabled
              title={stats.dump.reason ?? "pg_dump unavailable"}
            >
              {Icons.download} Download backup
            </button>
          ) : (
            <a
              className="btn btn-primary"
              href="/api/db/backup"
              title="Stream a fresh pg_dump of the whole database (plain SQL, gzipped) — same format as the scheduled backups, restorable with scripts/pg-restore.sh"
            >
              {Icons.download} Download backup
            </a>
          ))}
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load database stats: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <p className="hint">Measuring the database…</p>
      ) : stats ? (
        <>
          <div className="statbar" style={{ marginBottom: 20 }}>
            <div className="stat accent">
              <div className="stat-value">{formatBytes(db?.sizeBytes)}</div>
              <div className="stat-label">Database</div>
              <div className="stat-sub">PostgreSQL {db?.serverVersion}</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatBytes(largest?.totalBytes)}</div>
              <div className="stat-label">Largest table</div>
              <div className="stat-sub">{largest?.name ?? "—"}</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatBytes(faces?.bytes)}</div>
              <div className="stat-label">Face embeddings</div>
              <div className="stat-sub">
                {faces ? `${fmtRows(faces.rows)} faces` : "not analyzed yet"}
              </div>
            </div>
            <div className="stat">
              <div className="stat-value">
                {db?.pgvector ? formatBytes(clip?.bytes ?? 0) : "off"}
              </div>
              <div className="stat-label">CLIP index</div>
              <div className="stat-sub">
                {db?.pgvector
                  ? `${fmtRows(clip?.rows ?? 0)} embeddings`
                  : "pgvector not installed"}
              </div>
            </div>
            <div className="stat ok">
              <div className="stat-value">{db?.migrations.count ?? 0}</div>
              <div className="stat-label">Migrations</div>
              <div className="stat-sub">
                {db?.migrations.last ? `latest ${db.migrations.last}` : "none applied"}
              </div>
            </div>
          </div>

          <h3 style={{ margin: "0 0 8px" }}>Tables</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Sorted heaviest-first. <strong>Data</strong> is the row storage,{" "}
            <strong>TOAST</strong> the out-of-line storage where large values
            (embeddings, long text) actually land, <strong>Indexes</strong> all
            of the table’s indexes. Row counts are planner estimates, refreshed
            by autovacuum.
          </p>
          <div className="vol-table-wrap">
            <table className="vol-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="num">~ Rows</th>
                  <th className="num">Data</th>
                  <th className="num">TOAST</th>
                  <th className="num">Indexes</th>
                  <th className="num">Total</th>
                  <th style={{ width: "18%" }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {stats.tables.map((t) => {
                  const share = db?.sizeBytes
                    ? (t.totalBytes / db.sizeBytes) * 100
                    : 0;
                  return (
                    <tr key={t.name}>
                      <td>
                        <span className="vol-path">{t.name}</span>
                      </td>
                      <td className="num">{fmtRows(t.approxRows)}</td>
                      <td className="num">{formatBytes(t.heapBytes)}</td>
                      <td className="num">
                        {t.toastBytes > 0 ? formatBytes(t.toastBytes) : "—"}
                      </td>
                      <td className="num">{formatBytes(t.indexBytes)}</td>
                      <td className="num">
                        <strong>{formatBytes(t.totalBytes)}</strong>
                      </td>
                      <td>
                        <div
                          title={`${share.toFixed(1)}% of the database`}
                          style={{ display: "flex", alignItems: "center", gap: 8 }}
                        >
                          <div
                            style={{
                              flex: 1,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--color-surface-2)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.max(share, 0.5)}%`,
                                height: "100%",
                                borderRadius: 3,
                                background: "var(--color-accent)",
                              }}
                            />
                          </div>
                          <span
                            className="hint"
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontVariantNumeric: "tabular-nums",
                              minWidth: 44,
                              textAlign: "right",
                            }}
                          >
                            {share < 0.1 ? "<0.1" : share.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {stats.heavyColumns.length > 0 && (
            <>
              <h3 style={{ margin: "20px 0 8px" }}>Heavy columns</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                Exact on-disk weight (after TOAST compression) of the columns
                that grow with ML analysis — the usual suspects when the
                database balloons.
              </p>
              <div className="vol-table-wrap">
                <table className="vol-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>What it stores</th>
                      <th className="num">Values</th>
                      <th className="num">On disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.heavyColumns.map((h) => (
                      <tr key={`${h.table}.${h.column}`}>
                        <td>
                          <span className="vol-path">
                            {h.table}.{h.column}
                          </span>
                        </td>
                        <td className="hint">{h.label}</td>
                        <td className="num">{fmtRows(h.rows)}</td>
                        <td className="num">
                          <strong>{formatBytes(h.bytes)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 style={{ margin: "20px 0 8px" }}>Backups</h3>
          {!isAdmin ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Downloading backups is admin-only — a dump contains the whole
              database, credentials included.
            </p>
          ) : stats.backups.mounted ? (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Scheduled dumps taken by the <code>backup</code> sidecar
                (mounted read-only from <code>{stats.backups.dir}</code>).
                “Download backup” above streams a fresh one without touching
                these.
              </p>
              {stats.backups.files.length === 0 ? (
                <p className="hint">
                  No dumps yet — the sidecar writes its first one within its
                  BACKUP_INTERVAL of starting.
                </p>
              ) : (
                <div className="vol-table-wrap">
                  <table className="vol-table">
                    <thead>
                      <tr>
                        <th>Dump</th>
                        <th className="num">Size</th>
                        <th>Age</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.backups.files.map((f) => (
                        <tr key={f.name}>
                          <td>
                            <span className="vol-path">{f.name}</span>
                          </td>
                          <td className="num">{formatBytes(f.bytes)}</td>
                          <td>{formatRelativeTime(f.mtime)}</td>
                          <td>
                            <a
                              className="btn btn-sm"
                              href={`/api/db/backup/files/${encodeURIComponent(f.name)}`}
                            >
                              {Icons.download} Download
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="hint" style={{ marginTop: 0 }}>
              The scheduled dumps of the <code>backup</code> sidecar aren’t
              visible from here: mount their folder read-only into the app
              container (<code>- ./backups:{stats.backups.dir}:ro</code> in
              compose) to list and download them on this page. The “Download
              backup” button above works either way.
            </p>
          )}
        </>
      ) : null}
    </PullToRefresh>
  );
}
