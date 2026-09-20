"use client";

// Settings › Pipeline › Devices — giving a body to the media whose file never
// named one (cf. lib/deviceAttribution.ts).
//
// The case this exists for: `assets.device` is the grouping key of the whole
// gear dimension, and a DJI drone writes Make/Model on its stills but nothing
// at all in its MP4s. The clips are not badly filtered — they are outside the
// dimension, so the aircraft's card counts 0 videos and links to a grid that
// can never hold them.
//
// The list is browsed BY FOLDER, and that is the whole design. A flat list of
// media, ranked by date, is unusable the moment a few hundred are left: the
// drone clips of May sit between a screenshot from January and a Sony clip from
// June, and "keep attributing the drone" means hunting. One folder is one shoot
// is, very nearly always, one body — so a folder is a card with one verb, three
// hundred rows become thirty cards, and the body facet above them turns "the
// drone ones" into a click. Same shape, for the same reason, as the geotag
// backlog's folder groups (`docs/UNPLACED.md` §7); the card is literally the
// same `.session-card`.
//
// The per-file list inside a card exists for one case only — a folder that held
// two cameras — and is fetched only when the card is opened.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ActionMenu, { type MenuItem } from "../../../ActionMenu";
import ThumbStrip, { type StripItem } from "../../../ThumbStrip";
import { OptionPicker, type PickerOption } from "../../../OptionPicker";
import { EmptyState, Icons, Spinner } from "../../../ui";
import { useStats } from "../../../useStats";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { formatCaptureSpan } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import type {
  DeviceCandidate,
  DeviceFolder,
  DeviceSignal,
  FolderSort,
  KnownBody,
} from "@/lib/deviceAttribution";

// How many media one opened card fetches at a time.
const PAGE = 50;

// What each signal claims, in the words of the evidence rather than of the
// implementation — a card has to be readable by someone who has never opened
// lib/deviceAttribution.ts.
const SIGNAL_LABEL: Record<DeviceSignal, string> = {
  telemetry: "flight log",
  sidecar: ".SRT",
  filename: "maker filename",
  sibling: "folder’s body",
  folder: "folder name",
};
const SIGNAL_HINT: Record<DeviceSignal, string> = {
  telemetry:
    "A tied .SRT sidecar whose DJI flight log actually parsed — real GPS fixes, not a subtitle file.",
  sidecar: "A .SRT sidecar is tied to these clips.",
  filename: "The filenames follow a maker’s own scheme (DJI_…).",
  sibling:
    "Media in this folder already carry a camera body — the one proposed here.",
  folder: "The folder path names the gear (dji, drone, mavic…).",
};

type Payload = {
  folders: DeviceFolder[];
  bodies: KnownBody[];
  total: number;
  rules: { weights: Record<DeviceSignal, number>; confident: number };
};

// The body facet: one chip per proposed body, plus "no proposal". Derived from
// the folders themselves rather than from the library's bodies — a chip for a
// camera with nothing left to attribute would always come back empty.
type Facet = { key: string; label: string; folders: number; media: number };

function facets(folders: DeviceFolder[]): Facet[] {
  const by = new Map<string, Facet>();
  for (const f of folders) {
    const key = f.suggested_device ?? "";
    const hit = by.get(key);
    if (hit) {
      hit.folders += 1;
      hit.media += f.total;
    } else {
      by.set(key, {
        key,
        label: key ? friendlyCameraName(key) : "No proposal",
        folders: 1,
        media: f.total,
      });
    }
  }
  // Busiest first, but "no proposal" always last: it is the leftovers pile, not
  // a camera.
  return [...by.values()].sort(
    (a, b) =>
      Number(!a.key) - Number(!b.key) ||
      b.media - a.media ||
      a.label.localeCompare(b.label),
  );
}

function stripItems(f: DeviceFolder): StripItem[] {
  return f.sample.map((a) => ({
    key: a.id,
    thumbSrc: `/api/assets/${a.id}/thumb`,
    ext: a.ext,
    isVideo: a.media_type === "video",
  }));
}

/** "3 photos · 44 videos", dropping the half that is zero. */
function mediaMix(f: DeviceFolder): string {
  const parts: string[] = [];
  if (f.photos) parts.push(`${f.photos} photo${f.photos > 1 ? "s" : ""}`);
  if (f.videos) parts.push(`${f.videos} video${f.videos > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

export default function DeviceAttribution() {
  const { reload } = useStats();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<FolderSort>("size");
  const [facet, setFacet] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // The opened card: its folder id, the media fetched so far, and whether more
  // remain. Only ever one open at a time — two open lists is a screen nobody
  // reads.
  const [open, setOpen] = useState<{
    sessionId: number;
    items: DeviceCandidate[];
    total: number;
    loading: boolean;
  } | null>(null);
  // Per-medium overrides inside an opened card: id → included in the next
  // apply. Unset means "follow the vote", which is what the row shows.
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  const load = useCallback(async (s: FolderSort) => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await fetchJson<Payload>(
          `/api/pipeline/device-attribution?sort=${s}`,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(sort);
  }, [load, sort]);

  async function openFolder(f: DeviceFolder, offset = 0) {
    setOpen((o) =>
      offset === 0
        ? { sessionId: f.session_id, items: [], total: f.total, loading: true }
        : o && { ...o, loading: true },
    );
    if (offset === 0) setPicked({});
    try {
      const page = await fetchJson<{ items: DeviceCandidate[]; total: number }>(
        `/api/pipeline/device-attribution?session_id=${f.session_id}&limit=${PAGE}&offset=${offset}`,
      );
      setOpen((o) =>
        o && o.sessionId === f.session_id
          ? {
              sessionId: f.session_id,
              items: offset === 0 ? page.items : [...o.items, ...page.items],
              total: page.total,
              loading: false,
            }
          : o,
      );
    } catch (err) {
      setMsg((err as Error).message);
      setOpen(null);
    }
  }

  // Every write goes through here: a folder (a predicate the server resolves at
  // write time) or an explicit selection made inside an opened card.
  async function apply(
    key: number | "all",
    body: Record<string, unknown>,
    done: (r: { updated: number; skipped: number }) => string,
  ) {
    setBusy(key);
    setMsg(null);
    try {
      const res = await fetchJson<{ updated: number; skipped: number }>(
        "/api/pipeline/device-attribution",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      setMsg(done(res));
      setOpen(null);
      await load(sort);
      await reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const applyFolder = (f: DeviceFolder, opts: { confidentOnly?: boolean; device?: KnownBody } = {}) =>
    apply(
      f.session_id,
      {
        session_id: f.session_id,
        ...(opts.confidentOnly && data ? { min_score: data.rules.confident } : {}),
        ...(opts.device
          ? { device: opts.device.device, camera_model: opts.device.camera_model ?? undefined }
          : {}),
      },
      (r) =>
        r.updated
          ? `${f.name}: ${r.updated.toLocaleString()} media attributed${r.skipped ? `, ${r.skipped.toLocaleString()} left` : ""}.`
          : `${f.name}: nothing written — no body to apply. Pick one from the menu.`,
    );

  const applySelection = (f: DeviceFolder, ids: number[]) =>
    apply(
      f.session_id,
      { ids },
      (r) =>
        `${f.name}: ${r.updated.toLocaleString()} of ${ids.length.toLocaleString()} selected media attributed.`,
    );

  if (loading && !data) {
    return (
      <div className="pl-section">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="pl-section">
        <EmptyState
          icon={Icons.alert}
          title="Couldn’t read the attribution list"
          hint={error}
        />
      </div>
    );
  }

  if (!data || !data.total) {
    return (
      <div className="pl-section">
        <EmptyState
          icon={Icons.gear}
          title="Every medium has a body"
          hint="Nothing in the live library is missing its camera, so the gear shelf accounts for all of it. 🎉"
        />
      </div>
    );
  }

  const all = facets(data.folders);
  const shown = facet == null
    ? data.folders
    : data.folders.filter((f) => (f.suggested_device ?? "") === facet);
  const bulkTargets = shown.filter((f) => f.suggested_device);
  const bulkMedia = bulkTargets.reduce((n, f) => n + f.total, 0);

  const sortOptions: PickerOption<FolderSort>[] = [
    { key: "size", label: "Biggest first", hint: "The folders with the most media left" },
    { key: "recent", label: "Newest first", hint: "The folders shot most recently" },
  ];

  return (
    <div className="pl-section">
      {/* The body facet is the answer to "keep attributing the drone": one
          click and only its folders remain. */}
      <div className="filterbar pl-toolbar">
        <div className="chips">
          <button
            className={`chip${facet == null ? " active" : ""}`}
            onClick={() => setFacet(null)}
            aria-pressed={facet == null}
          >
            Every folder
            <span className="chip-count">{data.folders.length}</span>
          </button>
          {all.map((f) => (
            <button
              key={f.key || "none"}
              className={`chip${facet === f.key ? " active" : ""}`}
              onClick={() => setFacet(f.key)}
              aria-pressed={facet === f.key}
              title={`${f.media.toLocaleString()} media across ${f.folders} folder(s)`}
            >
              {f.label}
              <span className="chip-count">{f.folders}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <OptionPicker
          options={sortOptions}
          value={sort}
          onChange={setSort}
          ariaLabel="Order the folders"
        />
      </div>

      <div className="unplaced-head">
        <strong>{data.total.toLocaleString()}</strong> media carry no camera
        body, across <strong>{data.folders.length}</strong> folders — absent from
        the gear shelf and from every <code>?device=</code> grid until a body is
        written.
        <div className="hint card-rules">
          Nothing here was read from a file. A folder is proposed the body its
          own attributed media already carry, weighed per medium on five signals
          — a parsed flight log {data.rules.weights.telemetry}, a tied .SRT{" "}
          {data.rules.weights.sidecar}, a maker filename{" "}
          {data.rules.weights.filename}, the folder’s own body{" "}
          {data.rules.weights.sibling}, a folder name naming the gear{" "}
          {data.rules.weights.folder} — and a medium is confident at{" "}
          {data.rules.confident}. A card lists the signals more than half its
          media carry. A folder with no attributed sibling gets no proposal:
          pick its body from the card’s menu.
        </div>
      </div>

      {msg && <p className="hint">{msg}</p>}

      {bulkTargets.length > 1 && (
        <div className="filterbar">
          <span className="hint">
            {bulkTargets.length} of the folders shown carry a proposal,{" "}
            {bulkMedia.toLocaleString()} media in all.
          </span>
          <span className="spacer" />
          <button
            className="btn btn-sm"
            disabled={busy != null}
            onClick={async () => {
              for (const f of bulkTargets) {
                await fetchJson("/api/pipeline/device-attribution", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ session_id: f.session_id }),
                }).catch(() => null);
              }
              setMsg(
                `Applied every proposal shown — ${bulkMedia.toLocaleString()} media across ${bulkTargets.length} folders.`,
              );
              await load(sort);
              await reload();
            }}
            title="Give each of these folders the body its own media already carry"
          >
            Apply every proposal shown
          </button>
        </div>
      )}

      <div className="session-list">
        {shown.map((f) => {
          const label = f.suggested_device
            ? friendlyCameraName(f.suggested_device)
            : null;
          const isOpen = open?.sessionId === f.session_id;
          const menu: MenuItem[] = [
            // Only when the split is real: "assign the 0 confident" is not an
            // action, and neither is it one when every medium already clears
            // the bar — the primary verb covers that.
            ...(f.suggested_device && f.confident > 0 && f.confident < f.total
              ? [
                  {
                    key: "confident",
                    label: `Assign only the ${f.confident} confident`,
                    hint: `Leaves the ${f.total - f.confident} arguable in the list`,
                    icon: "✓",
                    onSelect: () => void applyFolder(f, { confidentOnly: true }),
                  } as MenuItem,
                ]
              : []),
            ...data.bodies.map(
              (b): MenuItem => ({
                key: `body-${b.device}`,
                label: `Assign ${f.total} to ${friendlyCameraName(b.device)}`,
                hint: b.device,
                icon: "→",
                onSelect: () => void applyFolder(f, { device: b }),
              }),
            ),
            {
              key: "review",
              label: isOpen ? "Close the media list" : `Review the ${f.total} one by one`,
              hint: "For a folder that held two cameras",
              icon: "☰",
              onSelect: () => (isOpen ? setOpen(null) : void openFolder(f)),
            },
          ];

          return (
            <div key={f.session_id} className="session-card is-stacked">
              <div className="card-head">
                <div className="card-info">
                  <h3>
                    <Link href={`/sessions/${f.session_id}`}>{f.name}</Link>
                  </h3>
                  <div className="meta">
                    <span>
                      {formatCaptureSpan(f.first_capture, f.last_capture)} ·{" "}
                      {mediaMix(f)}
                    </span>
                    <span className="pill" title="Media here carrying no camera body">
                      {f.total} without a body
                    </span>
                    {f.signals.map((s) => (
                      <span key={s} className="pill" title={SIGNAL_HINT[s]}>
                        {SIGNAL_LABEL[s]}
                      </span>
                    ))}
                  </div>
                  {label ? (
                    <div className="card-suggest">
                      Proposed: <strong>{label}</strong>
                      <span className="conf">
                        {f.confident === f.total
                          ? "all confident"
                          : `${f.confident} of ${f.total} confident`}
                      </span>
                    </div>
                  ) : (
                    <div className="card-suggest is-none">
                      No attributed media in this folder to learn from — pick a
                      body from the menu.
                    </div>
                  )}
                </div>
                <div className="card-side">
                  <div className="card-actions">
                    <button
                      className="btn btn-primary card-primary"
                      disabled={busy != null || !f.suggested_device}
                      onClick={() => void applyFolder(f)}
                      title={
                        f.suggested_device
                          ? "Give every medium here the body this folder already carries"
                          : "This folder has no proposal — pick a body from the menu"
                      }
                    >
                      {busy === f.session_id
                        ? "Applying…"
                        : label
                          ? `Assign ${f.total} to ${label}`
                          : "No proposal"}
                    </button>
                    <ActionMenu
                      ariaLabel={`More actions for ${f.name}`}
                      items={menu}
                    />
                  </div>
                </div>
              </div>

              <ThumbStrip items={stripItems(f)} total={f.total} />

              {isOpen && open && (
                <FolderMedia
                  folder={f}
                  state={open}
                  picked={picked}
                  onToggle={(id, on) =>
                    setPicked((p) => ({ ...p, [id]: on }))
                  }
                  onMore={() => void openFolder(f, open.items.length)}
                  onApply={(ids) => void applySelection(f, ids)}
                  busy={busy != null}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The per-file list inside an opened card. Deliberately plain: it is the
// exception path, not the screen. Each row shows what the vote saw and what it
// scored, and the selection starts from the vote's own verdict.
function FolderMedia({
  folder,
  state,
  picked,
  onToggle,
  onMore,
  onApply,
  busy,
}: {
  folder: DeviceFolder;
  state: { items: DeviceCandidate[]; total: number; loading: boolean };
  picked: Record<number, boolean>;
  onToggle: (id: number, on: boolean) => void;
  onMore: () => void;
  onApply: (ids: number[]) => void;
  busy: boolean;
}) {
  const isOn = (c: DeviceCandidate) => picked[c.id] ?? c.confident;
  const ids = state.items.filter(isOn).map((c) => c.id);

  return (
    <div className="dev-media">
      <div className="dev-media-head">
        <span className="hint">
          {state.items.length.toLocaleString()} of{" "}
          {state.total.toLocaleString()} shown · ticked as the vote sees them
        </span>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          disabled={busy || !ids.length}
          onClick={() => onApply(ids)}
          title="Attribute the ticked media with their own proposal"
        >
          Assign the {ids.length} ticked
        </button>
      </div>
      {state.items.map((c) => (
        <label key={c.id} className="dev-row">
          <input
            type="checkbox"
            checked={isOn(c)}
            onChange={(e) => onToggle(c.id, e.target.checked)}
          />
          <span className="dev-file">{c.filename}</span>
          <span className="dev-sig">
            {c.signals.map((s) => (
              <span key={s} className="pill" title={SIGNAL_HINT[s]}>
                {SIGNAL_LABEL[s]}
              </span>
            ))}
          </span>
          <span className={`dev-score${c.confident ? " is-confident" : ""}`}>
            {c.score}
          </span>
        </label>
      ))}
      {state.loading && <div className="pl-more"><Spinner sm /></div>}
      {!state.loading && state.items.length < state.total && (
        <div className="pl-more">
          <button className="btn btn-sm" onClick={onMore}>
            Load {Math.min(PAGE, state.total - state.items.length)} more
          </button>
        </div>
      )}
      {folder.suggested_device == null && (
        <p className="hint">
          These have no proposal of their own: use the card’s menu to give the
          whole folder a body.
        </p>
      )}
    </div>
  );
}
