"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  isAllNoExif,
  isReady,
  tileFor,
  type UnplacedGroup,
  type UnplacedResponse,
} from "@/lib/unplacedTypes";
import ActionMenu, { type MenuItem } from "./ActionMenu";
import GeotagRecapModal from "./GeotagRecapModal";
import type { PickedLocation } from "./LocationPickerModal";
import { OptionPicker, type PickerOption } from "./OptionPicker";
import ThumbStrip, { type StripItem } from "./ThumbStrip";
import { TILE_ATTRIBUTION, TILE_URL } from "./mapTiles";
import { EmptyState, Icons, SkeletonCards } from "./ui";

// The Incoming view for the geotagging backlog (docs/UNPLACED.md): one card per
// folder group — folders shot within a couple of hours of each other — with the
// count still to place, a suggested position drawn from the located frames shot
// in the same hours (the phone in the pocket while the Sony shoots), and one
// primary verb, Place. Every apply goes through the existing two-step flow
// (location picker → per-media recap) — this view contributes a pre-filled pin
// and a sentence saying where it came from, never a fourth path.
//
// The page is a work queue, and reads like one: a progress bar over the whole
// Incoming library at the top; a triage picker — Ready (a suggestion confident
// enough to pre-fill the map, so one glance and one click), By hand (a weak or
// missing suggestion, or a container folder), All — with the cards already
// sorted confident-first so the fast wins come before the archaeology; and on
// every suggestion a one-tile map preview centred on the point, because the
// fastest check on "Pérols, France" is seeing the coast, and the fastest check
// on a wrong suggestion is seeing the outback (§9 — the first real run offered
// one). The rules that produce the suggestions are printed, folded behind a
// disclosure so a phone gets the bar and the cards first.
//
// Three kinds of card, one markup (the session card's own — .session-card /
// .card-head / .meta-line / .card-actions / ThumbStrip; a folder group IS a
// session-shaped thing, and a second card family for the same object would be
// drift):
//   - a SHOOT: short folders merged by time — Place N;
//   - a PART of a container folder (a month, a year), cut at the same two-hour
//     silence that separates two shoots — "april 2026 · part 3 of 11", its
//     own window and suggestion, Place N applies inside the window;
//   - a SPAN: what a container keeps once its parts are cut out (media with no
//     camera EXIF, or no capture time), or a container too scattered to cut —
//     no pin to accept, so its primary verb sends you to the grid, where each
//     day's neighbours are visible.
// And one rule above the kinds: a card whose every unplaced media has no camera
// EXIF is screenshots and scans, and its primary verb is Exempt, not Place —
// the card says what it is instead of offering the wrong gesture.
//
// What is recorded depends on what the human did with the pin: accepted as
// offered (within `move_m` of the suggestion) → 'inferred', shown as such in
// the recap and never written into the originals; moved further, or placed
// with no suggestion at all → 'manual'.

// Leaflet touches `window` on import, so the geotag location picker (which
// embeds a map) is client-only — same treatment as the gallery's MapView.
const LocationPickerModal = dynamic(() => import("./LocationPickerModal"), {
  ssr: false,
});

type Triage = "all" | "ready" | "hand";

// The in-flight Place flow: the group, the media the recap will list (every
// live, non-exempt media the card covers — placed ones start unchecked there,
// as always), the pin the picker opens on (null = start blank), then the
// picked point once step 1 is done. A READY card skips step 1: its suggestion
// IS the point, and the recap is the confirmation — one glance, one click;
// the map stays one menu entry away for the cases where the pin needs a nudge.
type Flow = {
  group: UnplacedGroup;
  assets: GeotagAsset[];
  seed: { lat: number; lon: number } | null;
  loc?: PickedLocation;
};

// One verb: what the button says, what its tooltip explains, what it does.
type Verb = { label: string; title: string; run: () => void };

// One tile of the shared map source, cropped to a square and shifted so the
// point sits under the pin — a map preview with no map library, one lazy
// <img> per card. z=9 shows ~80 km across a tile at these latitudes: enough
// to tell a coast from a city from an empty continent, which is the check.
const THUMB_ZOOM = 9;
const THUMB_PX = 72;
const TILE_PX = 256;

const fmt = (n: number) => n.toLocaleString("en-GB");
const pct = (share: number) => `${Math.round(share * 100)} %`;
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

// A part's window is hours, not days, so it prints the times: "3 Apr 2026 ·
// 14:02–16:40". One that crosses midnight falls back to the day span.
function formatWindow(g: UnplacedGroup): string {
  if (g.kind !== "part") return formatCaptureSpan(g.t0, g.t1);
  const a = new Date(g.t0);
  const b = new Date(g.t1);
  if (a.toDateString() !== b.toDateString()) return formatCaptureSpan(g.t0, g.t1);
  const from = timeFmt.format(a);
  const to = timeFmt.format(b);
  return `${dayFmt.format(a)} · ${from === to ? from : `${from}–${to}`}`;
}

// YYYY-MM-DD in the browser's zone — the grid's date_from/date_to speak in
// calendar days.
function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function tileSrc(lat: number, lon: number): { src: string; fx: number; fy: number } {
  const t = tileFor(lat, lon, THUMB_ZOOM);
  const src = TILE_URL.replace("{s}", "a")
    .replace("{r}", "")
    .replace("{z}", String(t.z))
    .replace("{x}", String(t.x))
    .replace("{y}", String(t.y));
  return { src, fx: t.fx, fy: t.fy };
}

function MapThumb({ lat, lon, label }: { lat: number; lon: number; label: string }) {
  const { src, fx, fy } = tileSrc(lat, lon);
  return (
    <div className="unplaced-map" title={label} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={TILE_PX}
        height={TILE_PX}
        style={{
          left: THUMB_PX / 2 - fx * TILE_PX,
          top: THUMB_PX / 2 - fy * TILE_PX,
        }}
      />
      <span className="unplaced-map-pin" />
    </div>
  );
}

function groupTitle(g: UnplacedGroup): string {
  return g.sessions[0].name;
}

function groupDevices(g: UnplacedGroup): string {
  const set = new Set(g.sessions.map((s) => s.device_hint).filter(Boolean));
  return set.size ? [...set].join(" + ") : "unknown device";
}

function groupDays(g: UnplacedGroup): number {
  return Math.max(1, Math.round((Date.parse(g.t1) - Date.parse(g.t0)) / 86_400_000));
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
  return `From ${fmt(s.located)} located ${s.located === 1 ? "frame" : "frames"} shot ${when} — ${pct(s.share)} of them in one cell${who}.`;
}

function suggestionLabel(g: UnplacedGroup): string {
  const s = g.suggestion;
  if (!s) return "";
  return s.name ?? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
}

export default function UnplacedPane() {
  const router = useRouter();
  const [data, setData] = useState<UnplacedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [triage, setTriage] = useState<Triage>("all");

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

  const shown = useMemo(() => {
    const all = data?.groups ?? [];
    if (triage === "ready") return all.filter(isReady);
    if (triage === "hand") return all.filter((g) => !isReady(g));
    return all;
  }, [data, triage]);

  // Every live media the card covers, in one request: the folders' for a
  // shoot or a span, the folder's inside the card's window for a part. The
  // endpoint drops the exempted ones itself — they left the backlog for good
  // and must not come back through a bulk apply.
  const loadGroupAssets = useCallback(
    (g: UnplacedGroup): Promise<GeotagAsset[]> =>
      g.kind === "part"
        ? geotagTargets([g.sessions[0].id], { from: g.t0, to: g.t1 })
        : geotagTargets(g.sessions.map((s) => s.id)),
    [],
  );

  // Place. `how` decides where the flow starts:
  //   - "suggested": a ready card goes straight to the recap on its suggested
  //     point (recorded as 'inferred'); a card that is not ready falls back to
  //     the map, blank;
  //   - "map": the picker, seeded with the suggestion when there is one so a
  //     pin that needs a nudge starts where the nudge is, then the recap.
  const openPlace = useCallback(
    async (g: UnplacedGroup, how: "suggested" | "map") => {
      if (busyKey) return;
      setBusyKey(g.key);
      try {
        const assets = await loadGroupAssets(g);
        if (!assets.length) {
          setNotice("Nothing left to place here.");
          return;
        }
        const s = g.suggestion;
        const seed = s && g.kind !== "span" ? { lat: s.lat, lon: s.lon } : null;
        if (how === "suggested" && isReady(g) && s) {
          setFlow({
            group: g,
            assets,
            seed,
            loc: { lat: s.lat, lon: s.lon, label: s.name },
          });
          return;
        }
        setFlow({ group: g, assets, seed });
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets],
  );

  // Exempt the card's media that carry no camera EXIF at all — the census's
  // discriminator for screenshots and scans — one card at a time, never the
  // whole library, and never silently.
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
          setNotice("No media without camera EXIF left here.");
          return;
        }
        const n = await exemptAssets(ids, true);
        setNotice(`${fmt(n)} media marked as never needing a position`);
        await load();
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets, load],
  );

  // The grid, on the card's first folder and its unplaced media; a part also
  // narrows it to its day(s).
  const openGrid = useCallback(
    (g: UnplacedGroup) => {
      const sp = new URLSearchParams({
        session_id: String(g.sessions[0].id),
        geo_state: "todo",
      });
      if (g.kind === "part") {
        sp.set("date_from", isoDay(new Date(g.t0)));
        sp.set("date_to", isoDay(new Date(g.t1)));
      }
      router.push(`/library/incoming/grid?${sp}`);
    },
    [router],
  );

  // What the recap will record, decided by what the human did with the pin.
  const flowSource = (f: Flow): GeotagSource => {
    if (!f.seed || !f.loc) return "manual";
    return distanceM(f.seed, f.loc) <= (data?.rules.move_m ?? 100)
      ? "inferred"
      : "manual";
  };

  const rules = data?.rules;
  const totals = data?.totals;
  const anyMap = shown.some((g) => g.kind !== "span" && g.suggestion);

  // One primary verb per card (UI review), the rest behind the ⋯. Which verb
  // is primary is decided by what the card is, not by what is possible: a
  // screenshot pile exempts, a span opens in the grid, everything else places.
  function cardVerbs(g: UnplacedGroup): { primary: Verb; items: MenuItem[] } {
    const busy = busyKey != null;
    const n = fmt(g.unplaced);
    const place: Verb = {
      label: `Place ${n}`,
      title: isReady(g)
        ? "Place at the suggested position — confirm per media, no map step"
        : "Pick a position on the map, then confirm per media",
      run: () => void openPlace(g, "suggested"),
    };
    const grid: Verb = {
      label: `Open ${n} in grid`,
      title: "The unplaced media in the grid, day by day",
      run: () => openGrid(g),
    };
    const exempt: Verb = {
      label: `Exempt ${fmt(g.no_exif)} without camera EXIF`,
      title: "Screenshots, scans — never need a position",
      run: () => void exemptNoExif(g),
    };
    const item = (key: string, v: Verb, icon: string): MenuItem => ({
      key,
      label: v.label,
      hint: v.title,
      icon,
      disabled: busy,
      onSelect: v.run,
    });

    if (isAllNoExif(g)) {
      return {
        primary: exempt,
        items: [
          item(
            "place",
            { ...place, label: `Place ${n} anyway…`, run: () => void openPlace(g, "map") },
            "📌",
          ),
          item("grid", { ...grid, label: "Open in grid" }, "▦"),
        ],
      };
    }
    if (g.kind === "span") {
      const items = [
        item(
          "place",
          {
            ...place,
            label: `Place all ${n} at one point…`,
            title: "Only if the whole folder really is one place",
            run: () => void openPlace(g, "map"),
          },
          "📌",
        ),
      ];
      if (g.no_exif > 0) items.push(item("exempt", exempt, "⊘"));
      return { primary: grid, items };
    }
    const items: MenuItem[] = [];
    if (isReady(g)) {
      items.push(
        item(
          "pick",
          {
            label: "Pick a different place…",
            title: "Open the map on the suggestion and move the pin",
            run: () => void openPlace(g, "map"),
          },
          "📌",
        ),
      );
    }
    if (g.no_exif > 0) items.push(item("exempt", exempt, "⊘"));
    items.push(item("grid", { ...grid, label: "Open in grid" }, "▦"));
    return { primary: place, items };
  }

  // The line under the meta: the suggestion and its provenance, or why there
  // is none and what to do instead.
  function suggestLine(g: UnplacedGroup) {
    if (isAllNoExif(g)) {
      return (
        <div className="card-suggest is-none">
          Nothing here carries camera EXIF — screenshots or scans. Exempt them
          and this card is done.
        </div>
      );
    }
    if (g.kind === "span") {
      return (
        <div className="card-suggest is-none">
          {g.moments != null
            ? `Its unplaced camera media fall into ${fmt(g.moments)} separate moments over ${fmt(groupDays(g))} days — more than the ${rules?.parts_max ?? 40} parts a card list carries. Work it from the grid, where each day’s neighbours are visible.`
            : `What lies outside this folder’s parts: media with no camera EXIF or no capture time. Place them from the grid.`}
        </div>
      );
    }
    const s = g.suggestion;
    if (!s) {
      return (
        <div className="card-suggest is-none">
          No located frame within a day of these — place by hand.
        </div>
      );
    }
    return (
      <div className="card-suggest">
        Suggested: <strong>{suggestionLabel(g)}</strong>
        <span className={`conf is-${s.confidence}`}>{s.confidence}</span>
        <span className="hint"> — {suggestionNote(g)}</span>
      </div>
    );
  }

  const triageOptions: PickerOption<Triage>[] = [
    { key: "all", label: "All", count: totals?.groups },
    {
      key: "ready",
      label: "Ready",
      hint: "A suggestion confident enough to pre-fill the map — glance, confirm",
      count: totals?.ready,
    },
    {
      key: "hand",
      label: "By hand",
      hint: "A weak or missing suggestion, or a container folder",
      count: totals?.by_hand,
    },
  ];

  const barTotal = totals ? totals.placed + totals.unplaced + totals.exempt : 0;
  const barW = (n: number) => (barTotal ? `${(n / barTotal) * 100}%` : "0%");

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
      ) : !data || !totals || (data.groups.length === 0 && totals.unplaced === 0) ? (
        <EmptyState
          icon={Icons.inbox}
          title="Everything is placed"
          hint="Every Incoming media has a position or was marked as never needing one."
        />
      ) : (
        <>
          <div className="unplaced-head">
            <div
              className="unplaced-bar"
              role="img"
              aria-label={`${fmt(totals.placed)} placed, ${fmt(totals.unplaced)} to place, ${fmt(totals.exempt)} exempt`}
            >
              <span className="is-placed" style={{ width: barW(totals.placed) }} />
              <span className="is-todo" style={{ width: barW(totals.unplaced) }} />
              <span className="is-exempt" style={{ width: barW(totals.exempt) }} />
            </div>
            <div className="unplaced-legend">
              <span>
                <strong>{fmt(totals.unplaced)}</strong> to place
              </span>
              <span className="meta-sep">·</span>
              <span>{fmt(totals.placed)} placed</span>
              {totals.exempt > 0 && (
                <>
                  <span className="meta-sep">·</span>
                  <span>{fmt(totals.exempt)} exempt</span>
                </>
              )}
              <span className="meta-sep">·</span>
              <span>
                {fmt(totals.groups)} {totals.groups === 1 ? "card" : "cards"}
              </span>
              {totals.no_exif > 0 && (
                <>
                  <span className="meta-sep">·</span>
                  <span>{fmt(totals.no_exif)} without camera EXIF</span>
                </>
              )}
            </div>
            <div className="unplaced-tools">
              <OptionPicker
                size="sm"
                ariaLabel="Which cards to show"
                options={triageOptions}
                value={triage}
                onChange={setTriage}
              />
              {rules && (
                <details className="card-rules">
                  <summary>How the cards and their suggestions are made</summary>
                  <p className="hint">
                    Folders shot within {rules.gap_h} h of each other share a
                    card. A folder spanning more than {rules.span_max_h} h is a
                    container (a month, a year): its unplaced camera media are
                    cut into parts at every {rules.gap_h} h silence, each part
                    its own card, up to {rules.parts_max} parts — past that the
                    folder stays one card that opens in the grid. Media with no
                    camera EXIF (screenshots, scans) never take part in the cut
                    and stay behind to be exempted. A suggestion comes from the
                    located frames within ±{rules.near_h} h of the card’s window
                    (±{rules.day_h} h failing that), camera fixes and hand-placed
                    pins only. It pre-fills the map from {pct(rules.medium)} of
                    those frames in one cell — {pct(rules.high)} for high
                    confidence — and never under {rules.floor} frames. Accepting
                    the pin as offered records a suggested position, not written
                    into the originals; moving it more than {rules.move_m} m
                    records a verified one.
                  </p>
                </details>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon={Icons.inbox}
              title={triage === "ready" ? "Nothing ready to confirm" : "Nothing here"}
              hint={
                triage === "ready"
                  ? "No card has a confident suggestion left — the rest is by hand."
                  : "Switch to All to see every card."
              }
            />
          ) : (
            <div className="session-list">
              {shown.map((g) => {
                const s = g.suggestion;
                const busy = busyKey === g.key;
                const first = g.sessions[0];
                const devices = groupDevices(g);
                const { primary, items } = cardVerbs(g);
                return (
                  <div
                    key={g.key}
                    className={`session-card is-stacked unplaced-card is-${g.kind}`}
                  >
                    <div className="card-head">
                      {s && g.kind !== "span" && (
                        <MapThumb lat={s.lat} lon={s.lon} label={suggestionLabel(g)} />
                      )}
                      <div className="card-info">
                        <h3>
                          <Link href={`/sessions/${first.id}`}>{groupTitle(g)}</Link>
                          {g.part && (
                            <span className="hint">
                              {" "}
                              · part {g.part.index} of {g.part.count}
                            </span>
                          )}
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
                          <span className="meta-line">
                            <span className="meta-when">{formatWindow(g)}</span>
                            <span className="meta-sep">·</span>
                            <span className="meta-device" title={devices}>
                              {devices}
                            </span>
                            <span className="meta-sep">·</span>
                            <span className="meta-count">
                              {fmt(g.total)} {g.total === 1 ? "file" : "files"}
                            </span>
                          </span>
                          <span className="pill" title="No position yet, not exempted">
                            {fmt(g.unplaced)} unplaced
                          </span>
                          {g.no_exif > 0 && (
                            <span
                              className="pill"
                              title="Unplaced media with neither a camera model nor a lens — likely screenshots or scans"
                            >
                              {fmt(g.no_exif)} without camera EXIF
                            </span>
                          )}
                          {g.exempt > 0 && (
                            <span className="pill" title="Marked as never needing a position">
                              {fmt(g.exempt)} exempt
                            </span>
                          )}
                        </div>
                        {suggestLine(g)}
                      </div>
                      <div className="card-side">
                        <div className="card-actions">
                          <button
                            className="btn btn-primary card-primary"
                            disabled={busyKey != null}
                            onClick={primary.run}
                            title={primary.title}
                          >
                            {busy ? "Working…" : primary.label}
                          </button>
                          <ActionMenu
                            ariaLabel={`More actions for ${groupTitle(g)}`}
                            items={items}
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
          )}

          {anyMap && (
            <p
              className="hint unplaced-attrib"
              // The tile source's own attribution string (operator-configured,
              // HTML by contract — the map view renders the same one).
              dangerouslySetInnerHTML={{ __html: `Map previews ${TILE_ATTRIBUTION}` }}
            />
          )}
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
              ? `${suggestionNote(flow.group) ?? ""} To record a verified position instead, use “Pick a different place…” and move the pin.`
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
