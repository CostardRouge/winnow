"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import {
  exemptAssets,
  geotagTargets,
  type GeotagAsset,
  type GeotagSource,
} from "@/lib/assetActions";
import { formatCaptureSpan } from "@/lib/format";
import {
  distanceM,
  type UnplacedGroup,
  type UnplacedResponse,
} from "@/lib/unplacedTypes";
import ActionMenu, { type MenuItem } from "./ActionMenu";
import GeotagRecapModal from "./GeotagRecapModal";
import type { PickedLocation } from "./LocationPickerModal";
import ThumbStrip, { type StripItem } from "./ThumbStrip";
import { EmptyState, Icons, SkeletonCards } from "./ui";

// The Incoming view for the geotagging backlog (docs/UNPLACED.md): one card per
// folder group — folders shot within a couple of hours of each other — with the
// count still to place, a suggested position drawn from the located frames shot
// in the same hours (the phone in the pocket while the Sony shoots), and one
// primary verb, Place. Every apply goes through the existing two-step flow
// (location picker → per-media recap) — this view contributes a pre-filled pin
// and a sentence saying where it came from, never a fourth path.
//
// The cards wear the session card's own markup (.session-card / .card-head /
// .meta / .card-actions / ThumbStrip): a folder group IS a session-shaped
// thing, and a second card family for the same object would be drift.
//
// What is recorded depends on what the human did with the pin: accepted as
// offered (within `move_m` of the suggestion) → 'inferred', shown as such in
// the recap and never written into the originals; moved further, or placed
// with no suggestion at all → 'manual'. The rules — the grouping gap, the donor
// windows, the confidence thresholds, the move distance — come back with the
// data and are printed above the list: a decision nobody can see is one nobody
// trusts.

// Leaflet touches `window` on import, so the geotag location picker (which
// embeds a map) is client-only — same treatment as the gallery's MapView.
const LocationPickerModal = dynamic(() => import("./LocationPickerModal"), {
  ssr: false,
});

// The in-flight Place flow: the group, the media the recap will list (every
// live, non-exempt media of the group's folders — placed ones start unchecked
// there, as always), the pin the picker opens on (null = start blank), then
// the picked point once step 1 is done.
type Flow = {
  group: UnplacedGroup;
  assets: GeotagAsset[];
  seed: { lat: number; lon: number } | null;
  loc?: PickedLocation;
};

const pct = (share: number) => `${Math.round(share * 100)} %`;

function groupTitle(g: UnplacedGroup): string {
  return g.sessions[0].name;
}

function groupDevices(g: UnplacedGroup): string {
  const set = new Set(g.sessions.map((s) => s.device_hint).filter(Boolean));
  return set.size ? [...set].join(" + ") : "unknown device";
}

function stripItems(g: UnplacedGroup): StripItem[] {
  return g.sample.map((a) => ({
    key: a.id,
    thumbSrc: `/api/assets/${a.id}/thumb`,
    ext: a.ext,
    isVideo: a.media_type === "video",
  }));
}

// One line saying what the suggestion is and where it came from, in words —
// the same sentence the recap repeats so the person confirming it never has to
// remember it from the card.
function suggestionNote(g: UnplacedGroup): string | null {
  const s = g.suggestion;
  if (!s) return null;
  const when = s.window === "near" ? "in the same hours" : "within a day";
  const who = s.donor_model ? `, mostly ${s.donor_model}` : "";
  return `From ${s.located} located ${s.located === 1 ? "frame" : "frames"} shot ${when} — ${pct(s.share)} of them in one cell${who}.`;
}

export default function UnplacedPane() {
  const router = useRouter();
  const [data, setData] = useState<UnplacedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchJson<UnplacedResponse>("/api/assets/unplaced"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-dismiss the notice, like the sessions list.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Every live media of the group's folders in one request. The endpoint drops
  // the exempted ones itself — they left the backlog for good and must not come
  // back through a bulk apply.
  const loadGroupAssets = useCallback(
    (g: UnplacedGroup): Promise<GeotagAsset[]> =>
      geotagTargets(g.sessions.map((s) => s.id)),
    [],
  );

  // Place: open the picker on the suggestion (when it is confident enough to
  // be seeded) or blank, then the recap.
  const openPlace = useCallback(
    async (g: UnplacedGroup, seeded: boolean) => {
      if (busyKey) return;
      setBusyKey(g.key);
      try {
        const assets = await loadGroupAssets(g);
        if (!assets.length) {
          setNotice("Nothing left to place in these folders.");
          return;
        }
        const s = g.suggestion;
        const seed =
          seeded && s && s.confidence !== "low" ? { lat: s.lat, lon: s.lon } : null;
        setFlow({ group: g, assets, seed });
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets],
  );

  // Exempt the group's media that carry no camera EXIF at all — the census's
  // discriminator for screenshots and scans — one folder group at a time,
  // never the whole library, and never silently.
  const exemptNoExif = useCallback(
    async (g: UnplacedGroup) => {
      if (busyKey) return;
      setBusyKey(g.key);
      try {
        const assets = await loadGroupAssets(g);
        const ids = assets
          .filter((a) => !a.gps && !a.camera_model && !a.lens)
          .map((a) => a.id);
        if (!ids.length) {
          setNotice("No media without camera EXIF left in these folders.");
          return;
        }
        const n = await exemptAssets(ids, true);
        setNotice(`${n} media marked as never needing a position`);
        await load();
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets, load],
  );

  // What the recap will record, decided by what the human did with the pin.
  const flowSource = (f: Flow): GeotagSource => {
    if (!f.seed || !f.loc) return "manual";
    return distanceM(f.seed, f.loc) <= (data?.rules.move_m ?? 100)
      ? "inferred"
      : "manual";
  };

  const rules = data?.rules;

  function cardMenu(g: UnplacedGroup): MenuItem[] {
    const busy = busyKey != null;
    const s = g.suggestion;
    const items: MenuItem[] = [];
    if (s && s.confidence !== "low") {
      items.push({
        key: "pick",
        label: "Pick a different place…",
        hint: "Open the map without the suggestion",
        icon: "📌",
        disabled: busy,
        onSelect: () => void openPlace(g, false),
      });
    }
    items.push({
      key: "exempt",
      label: `Exempt ${g.no_exif} without camera EXIF`,
      hint: "Screenshots, scans — never need a position",
      icon: "⊘",
      disabled: busy || g.no_exif === 0,
      onSelect: () => void exemptNoExif(g),
    });
    items.push({
      key: "grid",
      label: "Open in grid",
      hint: "The unplaced media of the first folder",
      icon: "▦",
      onSelect: () =>
        router.push(
          `/library/incoming/grid?session_id=${g.sessions[0].id}&geo_state=todo`,
        ),
    });
    return items;
  }

  return (
    <div className="sessions-pane">
      {notice && (
        <div style={{ marginBottom: 12 }}>
          <span className="notice">{notice}</span>
        </div>
      )}
      {error && (
        <div className="error-box">
          <span>Couldn’t load the backlog: {error}</span>
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonCards rows={5} />
      ) : !data || data.groups.length === 0 ? (
        <EmptyState
          icon={Icons.inbox}
          title="Everything is placed"
          hint="Every Incoming media has a position or was marked as never needing one."
        />
      ) : (
        <>
          <div className="unplaced-head">
            <strong>
              {data.totals.groups} folder {data.totals.groups === 1 ? "group" : "groups"}
            </strong>{" "}
            · {data.totals.unplaced} media to place
            {data.totals.no_exif > 0 && (
              <> · {data.totals.no_exif} without camera EXIF</>
            )}
            {rules && (
              <div className="hint unplaced-rules">
                Folders shot within {rules.gap_h} h of each other share a card.
                A suggestion comes from the located frames within ±{rules.near_h} h
                of the card’s window (±{rules.day_h} h failing that), camera fixes
                and hand-placed pins only. It pre-fills the map from{" "}
                {pct(rules.medium)} of those frames in one cell — {pct(rules.high)}{" "}
                for high confidence — and never under {rules.floor} frames.
                Accepting the pin as offered records a suggested position, not
                written into the originals; moving it more than {rules.move_m} m
                records a verified one.
              </div>
            )}
          </div>

          <div className="session-list">
            {data.groups.map((g) => {
              const s = g.suggestion;
              const seedable = !!s && s.confidence !== "low";
              const busy = busyKey === g.key;
              const first = g.sessions[0];
              return (
                <div key={g.key} className="session-card is-stacked">
                  <div className="card-head">
                    <div className="card-info">
                      <h3>
                        <Link href={`/sessions/${first.id}`}>{groupTitle(g)}</Link>
                        {g.sessions.length > 1 && (
                          <span
                            className="hint"
                            title={g.sessions.map((x) => x.name).join("\n")}
                          >
                            {" "}
                            + {g.sessions.length - 1} more{" "}
                            {g.sessions.length - 1 === 1 ? "folder" : "folders"}
                          </span>
                        )}
                      </h3>
                      <div className="meta">
                        <span>
                          {formatCaptureSpan(g.t0, g.t1)} · {groupDevices(g)} ·{" "}
                          {g.total} {g.total === 1 ? "file" : "files"}
                        </span>
                        <span className="pill" title="No position yet, not exempted">
                          {g.unplaced} unplaced
                        </span>
                        {g.no_exif > 0 && (
                          <span
                            className="pill"
                            title="Unplaced media with neither a camera model nor a lens — likely screenshots or scans"
                          >
                            {g.no_exif} without camera EXIF
                          </span>
                        )}
                        {g.exempt > 0 && (
                          <span className="pill" title="Marked as never needing a position">
                            {g.exempt} exempt
                          </span>
                        )}
                      </div>
                      {s ? (
                        <div className="unplaced-suggest">
                          Suggested: <strong>{s.name ?? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`}</strong>
                          <span className="conf">{s.confidence}</span>
                          <span className="hint"> — {suggestionNote(g)}</span>
                        </div>
                      ) : (
                        <div className="unplaced-suggest is-none">
                          No located frame within a day of these — place by hand.
                        </div>
                      )}
                    </div>
                    <div className="card-side">
                      <div className="card-actions">
                        <button
                          className="btn btn-primary card-primary"
                          disabled={busyKey != null}
                          onClick={() => void openPlace(g, true)}
                          title={
                            seedable
                              ? "Open the map on the suggested position, then confirm per media"
                              : "Pick a position on the map, then confirm per media"
                          }
                        >
                          {busy ? "Loading…" : `Place ${g.unplaced}`}
                        </button>
                        <ActionMenu
                          ariaLabel={`More actions for ${groupTitle(g)}`}
                          items={cardMenu(g)}
                        />
                      </div>
                    </div>
                  </div>
                  <ThumbStrip
                    items={stripItems(g)}
                    total={g.total}
                    onItemActivate={() => router.push(`/sessions/${first.id}`)}
                    onOverflowActivate={() => router.push(`/sessions/${first.id}`)}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      {flow && !flow.loc && (
        <LocationPickerModal
          count={flow.assets.length}
          initial={flow.seed}
          onClose={() => setFlow(null)}
          onPicked={(loc) => setFlow({ ...flow, loc })}
        />
      )}
      {flow?.loc && (
        <GeotagRecapModal
          assets={flow.assets}
          target={flow.loc}
          source={flowSource(flow)}
          sourceNote={
            flowSource(flow) === "inferred"
              ? `${suggestionNote(flow.group) ?? ""} Move the pin to record a verified position instead.`
              : null
          }
          onClose={() => setFlow(null)}
          onApplied={(message) => {
            setFlow(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </div>
  );
}
