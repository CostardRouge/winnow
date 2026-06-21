"use client";

// Pipeline "HEIC rotation" maintenance page. Scans every ready HEIC/HEIF photo
// for the double-rotation bug (container transform + EXIF orientation both
// applied by the pre-fix worker), shows the stats and the affected files (with
// their current, wrongly-rotated thumbnail), and re-queues them for regeneration
// — one by one or all at once. Lives under /pipeline (heading + tabs come from
// the layout). The scan walks the originals on the NAS, so it's button-triggered,
// never polled.
import { useCallback, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { Icons, LazyImage } from "../../ui";

type Item = {
  id: number;
  filename: string;
  abs_path: string;
  ext: string;
  orientation: number;
};

type Report = {
  scanned: number;
  missing: number;
  ok: number;
  affectedCount: number;
  items: Item[];
  itemsCapped: boolean;
  affectedIds: number[];
  ranAtMs: number;
};

// EXIF orientation → human angle, for the per-row badge.
const ANGLE: Record<number, string> = { 3: "180°", 6: "90°", 8: "270°" };

export default function HeicRotationPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  // Key of the in-flight fix ("all" or "one:<id>"), to spin one button while the
  // rest stay disabled; ids already re-queued so their rows show "Queued".
  const [busy, setBusy] = useState<string | null>(null);
  const [fixed, setFixed] = useState<Set<number>>(new Set());

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setMsg("");
    try {
      const r = await fetchJson<Report>("/api/pipeline/heic-rotation");
      setReport(r);
      setFixed(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, []);

  const fix = useCallback(
    async (ids: number[], key: string) => {
      if (!ids.length || busy) return;
      setBusy(key);
      setMsg("");
      try {
        const r = await fetch("/api/assets/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const d = await r.json();
        if (!r.ok) {
          setMsg(`Error: ${d.error ?? "unknown"}`);
        } else {
          setFixed((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(id);
            return next;
          });
          setMsg(
            `Re-queued ${d.queued ?? ids.length} asset(s). Run the worker to rebuild them, then re-scan to confirm.`,
          );
        }
      } catch (e) {
        setMsg(`Error: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const pendingIds = (report?.affectedIds ?? []).filter((id) => !fixed.has(id));
  const allFixed = report != null && report.affectedCount > 0 && pendingIds.length === 0;

  return (
    <section className="pl-section">
      <div className="filterbar">
        <span className="hint">
          Finds HEIC/HEIF whose thumbnail/proxy was rotated twice (the original
          stores its orientation in both the HEIF container and EXIF). Scanning
          reads the originals’ metadata on the NAS — it can take a moment.
        </span>
        <span className="spacer" />
        <button className="btn" onClick={scan} disabled={scanning || busy !== null}>
          {scanning ? "Scanning…" : report ? "Re-scan" : "Scan now"}
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Scan failed: {error}</span>
          <button className="btn" onClick={scan}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {report && (
        <>
          <div className="filterbar" style={{ marginTop: 8, marginBottom: 6 }}>
            <span className="pill total">{report.scanned} scanned</span>
            <span className={`pill${report.affectedCount ? " error" : " ready"}`}>
              {report.affectedCount} affected
            </span>
            <span className="pill ready">{report.ok} OK</span>
            {report.missing > 0 && (
              <span className="pill pending">{report.missing} unreachable</span>
            )}
            <span className="spacer" />
            {report.affectedCount > 0 && (
              <button
                className="btn"
                onClick={() => fix(pendingIds, "all")}
                disabled={busy !== null || allFixed}
              >
                {Icons.regenerate}
                <span>
                  {busy === "all"
                    ? "…"
                    : allFixed
                      ? "All re-queued"
                      : `Fix all (${pendingIds.length})`}
                </span>
              </button>
            )}
          </div>

          {report.affectedCount === 0 ? (
            <div className="empty" style={{ padding: 16 }}>
              No double-rotated HEIC derivatives. 🎉
            </div>
          ) : (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Thumbnails below are the current (wrong) derivatives — fixing
                re-queues generation with the corrected orientation handling.
              </p>
              <div className="fail-list">
                {report.items.map((it) => {
                  const done = fixed.has(it.id);
                  const oneKey = `one:${it.id}`;
                  return (
                    <div className="fail-row" key={it.id}>
                      <div className="fail-head">
                        <div className="pl-thumb" aria-hidden>
                          <LazyImage src={`/api/assets/${it.id}/thumb`} alt="" />
                        </div>
                        <strong className="fail-title">
                          #{it.id} · {it.filename}
                        </strong>
                        <span className="pill">
                          {it.ext} · {ANGLE[it.orientation] ?? `orient ${it.orientation}`}
                        </span>
                        <span className="spacer" />
                        <a
                          className="btn btn-sm btn-icon"
                          href={`/api/assets/${it.id}/download`}
                          download
                          title="Download the original file"
                          aria-label="Download the original file"
                        >
                          {Icons.download}
                        </a>
                        <button
                          className="btn btn-sm"
                          onClick={() => fix([it.id], oneKey)}
                          disabled={busy !== null || done}
                        >
                          {busy === oneKey ? "…" : done ? "Queued ✓" : "Fix"}
                        </button>
                      </div>
                      <div className="fail-path">{it.abs_path}</div>
                    </div>
                  );
                })}
              </div>
              {report.itemsCapped && (
                <p className="hint">
                  Showing the first {report.items.length} of {report.affectedCount}.
                  “Fix all” re-queues every affected asset.
                </p>
              )}
            </>
          )}
        </>
      )}

      {!report && !scanning && !error && (
        <div className="empty" style={{ padding: 16 }}>
          Run a scan to check your HEIC/HEIF derivatives for double rotation.
        </div>
      )}
    </section>
  );
}
