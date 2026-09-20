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
// The page is deliberately a WORKSHOP rather than a one-click backfill. Every
// signal it shows was read from Postgres, never from a file, and none of them
// is conclusive on its own — so it ranks the evidence, pre-selects what two
// independent signals agree on, and leaves the rest to a human. Two ways to
// act, both bulk:
//   • "Apply suggested" — each selected row takes the busiest body of its own
//     folder (device_source='derived'). One click for the obvious mass.
//   • "Assign to <body>" — the whole selection takes the picked body
//     (device_source='manual'). The escape hatch, and the one that handles a
//     folder with no attributed sibling to learn from.
// Either way the write only ever fills a hole, and the provenance it stamps is
// what stops the next re-index wiping it (migration 0042).
import { useCallback, useEffect, useState } from "react";
import { OptionPicker, type PickerOption } from "../../../OptionPicker";
import { EmptyState, Icons, Spinner } from "../../../ui";
import { useStats } from "../../../useStats";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { formatDateTime } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import type {
  DeviceCandidate,
  DeviceSignal,
  KnownBody,
} from "@/lib/deviceAttribution";

const PAGE = 200;

// What each signal claims, in the words of the evidence rather than of the
// implementation — the row has to be readable by someone who has never seen
// lib/deviceAttribution.ts.
const SIGNAL_LABEL: Record<DeviceSignal, string> = {
  telemetry: "flight log",
  sidecar: ".SRT",
  filename: "name",
  sibling: "folder body",
  folder: "folder name",
};
const SIGNAL_HINT: Record<DeviceSignal, string> = {
  telemetry:
    "A tied .SRT sidecar whose DJI flight log actually parsed — real GPS fixes, not a subtitle file.",
  sidecar: "A .SRT sidecar is tied to this clip.",
  filename: "The filename follows a maker's own naming scheme (DJI_…).",
  sibling:
    "Another medium in the same folder already carries a camera body — the one proposed here.",
  folder: "The folder path names the gear (dji, drone, mavic…).",
};

type Payload = { items: DeviceCandidate[]; total: number; bodies: KnownBody[] };

export default function DeviceAttribution() {
  const { reload } = useStats();
  const [items, setItems] = useState<DeviceCandidate[]>([]);
  const [bodies, setBodies] = useState<KnownBody[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [body, setBody] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<Payload>(
        `/api/pipeline/device-attribution?limit=${PAGE}`,
      );
      setItems(data.items);
      setBodies(data.bodies);
      setTotal(data.total);
      // Pre-select what the vote is confident about: the page opens on the
      // answer, not on a blank form. Anything arguable stays unticked.
      setSelected(new Set(data.items.filter((i) => i.confident).map((i) => i.id)));
      setBody((b) => b || data.bodies[0]?.device || "");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pick = (which: "all" | "confident" | "none") =>
    setSelected(
      which === "none"
        ? new Set()
        : new Set(
            items
              .filter((i) => which === "all" || i.confident)
              .map((i) => i.id),
          ),
    );

  // One apply path for both buttons: `device` present = the picked body for
  // everything selected, absent = each row's own proposal. The server
  // recomputes the proposals either way, so a page left open overnight cannot
  // write a stale one.
  async function apply(device?: string) {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const chosen = bodies.find((b) => b.device === device);
      const res = await fetchJson<{ updated: number; skipped: number }>(
        "/api/pipeline/device-attribution",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids,
            ...(device
              ? { device, camera_model: chosen?.camera_model ?? undefined }
              : {}),
          }),
        },
      );
      setMsg(
        res.updated
          ? `Attributed ${res.updated.toLocaleString()} media` +
              (res.skipped
                ? ` · ${res.skipped.toLocaleString()} skipped (no proposal, or already attributed)`
                : "") +
              ". They now group under that body on /gear and answer its ?device= grid."
          : "Nothing written — the selection had no proposal to apply. Pick a body and use Assign instead.",
      );
      await load();
      await reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const bodyOptions: PickerOption<string>[] = bodies.map((b) => ({
    key: b.device,
    label: friendlyCameraName(b.device),
    hint: `${b.device} — ${b.count.toLocaleString()} media already carry it`,
    count: b.count,
  }));
  const chosenLabel = body ? friendlyCameraName(body) : "";
  const suggestable = items.filter(
    (i) => selected.has(i.id) && i.suggested_device,
  ).length;

  if (loading && !items.length) {
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

  if (!total) {
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

  return (
    <div className="pl-section">
      <div className="filterbar pl-toolbar">
        {bodyOptions.length > 0 && (
          <OptionPicker
            options={bodyOptions}
            value={body}
            onChange={setBody}
            ariaLabel="Camera body to assign"
          />
        )}
        <span className="spacer" />
        <button
          className="btn btn-sm"
          disabled={busy || !suggestable}
          onClick={() => void apply()}
          title="Give each selected medium the busiest body of its own folder"
        >
          {busy ? "Applying…" : `✓ Apply suggested (${suggestable})`}
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !selected.size || !body}
          onClick={() => void apply(body)}
          title="Give every selected medium the body picked on the left"
        >
          {busy
            ? "Applying…"
            : `→ Assign to ${chosenLabel} (${selected.size})`}
        </button>
      </div>

      {msg && <p className="hint">{msg}</p>}

      <p className="hint">
        {total.toLocaleString()} medium{total > 1 ? "s" : ""} in the live library
        carry no camera body, so they are absent from the gear shelf and from
        every <code>?device=</code> grid. Nothing here was read from a file: each
        row is ranked on what the index already knows about it. Rows two
        independent signals agree on are ticked for you.
      </p>

      <div className="chips">
        <button className="chip" onClick={() => pick("confident")}>
          Select confident
        </button>
        <button className="chip" onClick={() => pick("all")}>
          Select all shown
        </button>
        <button className="chip" onClick={() => pick("none")}>
          Select none
        </button>
      </div>

      <div className="pl-list">
        {items.map((i) => (
          <div className="pl-row" key={i.id}>
            <label className="pl-check" title="Include in the next apply">
              <input
                type="checkbox"
                checked={selected.has(i.id)}
                onChange={() => toggle(i.id)}
              />
            </label>
            <div className="pl-main">
              <div className="pl-name">
                {i.filename}
                {i.confident && <span className="pill ready">confident</span>}
                {i.signals.map((s) => (
                  <span key={s} className="pill" title={SIGNAL_HINT[s]}>
                    {SIGNAL_LABEL[s]}
                  </span>
                ))}
              </div>
              <div className="pl-path">{i.rel_path}</div>
              <div className="pl-meta">
                {[
                  i.media_type,
                  formatDateTime(i.captured_at),
                  i.session_name,
                  i.suggested_device
                    ? `→ ${friendlyCameraName(i.suggested_device)}`
                    : "no proposal — pick a body",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </div>
        ))}
      </div>

      {total > items.length && (
        <p className="hint">
          Showing the {items.length.toLocaleString()} most recent of{" "}
          {total.toLocaleString()}. Apply these, then reload for the next batch —
          the list is what is left to do, so it empties as you work.
        </p>
      )}
    </div>
  );
}
