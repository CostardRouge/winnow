"use client";

// The favourites pass (docs/FAVOURITES.md §5): one folder as a contact sheet of
// MOMENTS — a burst pile, a run of look-alikes — where a tap is a ♥ and nothing
// else happens to the rest. No reject, no skip, no verdict: the pass answers
// "which of these do I want to show", not "which do I keep", so a 600-frame
// folder is a couple of minutes of taps instead of a cull.
//
// Phone first: three columns at 390 px, more on a wider screen; every target
// is a whole tile. Each tile shows the moment's cover (lib/moments.ts: the
// frame already chosen, else the sharpest); a moment of several frames carries
// a ×N button that opens them all, to put the ♥ on another one.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { favouriteAssets } from "@/lib/assetActions";
import type { Moment } from "@/lib/moments";
import type { PassFrame } from "@/lib/sessionMoments";
import PageHeader from "@/app/PageHeader";
import { HeartIcon } from "@/app/FavouriteHeart";
import { EmptyState, LoadingState } from "@/app/ui";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";

// What a recap needs from one folder: ten to twenty pictures. A guide printed
// on the counter, never a limit.
const AIM_LOW = 10;
const AIM_HIGH = 20;

type Data = {
  session: { id: number; name: string; root_kind: string };
  frames: PassFrame[];
  moments: Moment[];
};

function timeOf(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function Thumb({ frame }: { frame: PassFrame | undefined }) {
  if (!frame) return null;
  return frame.ready ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/assets/${frame.id}/thumb`} alt="" loading="lazy" decoding="async" />
  ) : (
    <span className="pass-placeholder">{frame.media_type === "video" ? "Video" : "No preview yet"}</span>
  );
}

export default function FavouritesPass({ id }: { id: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ♥ per frame, as the page holds it (optimistic, put back on refusal).
  const [fav, setFav] = useState<Map<number, boolean>>(new Map());
  const [suggest, setSuggest] = useState(false);
  const [onlyFav, setOnlyFav] = useState(false);
  const [open, setOpen] = useState<number | null>(null); // index of the moment in the sheet
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchJson<Data>(`/api/sessions/${id}/moments`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setFav(new Map(d.frames.map((f) => [f.id, f.favourite])));
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const frameById = useMemo(
    () => new Map((data?.frames ?? []).map((f) => [f.id, f])),
    [data],
  );

  const write = useCallback(async (ids: number[], on: boolean) => {
    if (!ids.length) return;
    let before = new Map<number, boolean>();
    setFav((prev) => {
      before = prev;
      const next = new Map(prev);
      for (const i of ids) next.set(i, on);
      return next;
    });
    try {
      await favouriteAssets(ids, on);
    } catch (e) {
      setFav((cur) => {
        const next = new Map(cur);
        for (const i of ids) next.set(i, before.get(i) ?? false);
        return next;
      });
      setNotice((e as Error).message);
    }
  }, []);

  const favIds = (m: Moment) => m.ids.filter((i) => fav.get(i));
  // The tile shows the moment's ♥ when one is set; else the server's cover.
  const coverOf = (m: Moment) => favIds(m)[0] ?? m.cover_id;

  // A tap on a tile: no ♥ in the moment → the cover gets one; one or more →
  // they are all cleared (the sheet is where a second frame is chosen).
  const tap = (m: Moment) => {
    const set = favIds(m);
    if (set.length) void write(set, false);
    else void write([m.cover_id], true);
  };

  if (error)
    return (
      <>
        <PageHeader back={`/sessions/${id}`} backLabel="Back to the folder" title="Favourites pass" />
        <div className="error-box pass-error">
          <span>{error}</span>
        </div>
      </>
    );
  if (!data) return <LoadingState label="Reading the folder…" />;

  const moments = data.moments;
  const count = data.frames.filter((f) => fav.get(f.id)).length;
  const withFav = moments.filter((m) => favIds(m).length > 0).length;
  const shown = onlyFav
    ? moments.map((m, i) => ({ m, i })).filter(({ m }) => favIds(m).length > 0)
    : moments.map((m, i) => ({ m, i }));
  const pct = Math.min(100, Math.round((count / AIM_HIGH) * 100));
  const sheet = open != null ? moments[open] : null;

  return (
    <>
      <PageHeader
        back={`/sessions/${id}`}
        backLabel="Back to the folder"
        title="Favourites pass"
        subtitle={
          <span>
            {data.session.name} · {data.frames.length.toLocaleString("en-GB")} media →{" "}
            {moments.length.toLocaleString("en-GB")} moments
          </span>
        }
        trailing={notice ? <span className="notice">{notice}</span> : undefined}
      />

      <div className="page-tools pass-tools">
        <div className="pass-counter" aria-live="polite">
          <span className="pass-count">
            <HeartIcon filled size={15} />
            {count}
          </span>
          <span className="pass-aim">
            aim {AIM_LOW}–{AIM_HIGH} for a recap
            {withFav !== count && ` · in ${withFav} moments`}
          </span>
          <span className="pass-bar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>
        <span className="spacer" />
        <div className="view-toggle" role="group" aria-label="Show">
          <button
            type="button"
            className={`view-btn${onlyFav ? "" : " active"}`}
            aria-pressed={!onlyFav}
            onClick={() => setOnlyFav(false)}
          >
            Moments
          </button>
          <button
            type="button"
            className={`view-btn${onlyFav ? " active" : ""}`}
            aria-pressed={onlyFav}
            onClick={() => setOnlyFav(true)}
          >
            ♥ <span className="view-count">{withFav}</span>
          </button>
        </div>
        <button
          type="button"
          className={`btn${suggest ? " btn-primary" : ""}`}
          aria-pressed={suggest}
          title="Outline a few moments worth a first look — a hint, nothing is marked"
          onClick={() => setSuggest((s) => !s)}
        >
          Suggest
        </button>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={onlyFav ? "No favourite yet" : "Nothing to show"}
          hint={
            onlyFav
              ? "Tap a moment to mark it ♥."
              : "This folder holds no live media."
          }
        />
      ) : (
        <div className="pass-grid">
          {shown.map(({ m, i }) => {
            const on = favIds(m).length > 0;
            const hint = suggest && !on ? m.suggested : undefined;
            const cover = frameById.get(coverOf(m));
            return (
              <div
                key={m.ids[0]}
                className={`pass-tile${on ? " on" : ""}${hint ? " suggested" : ""}`}
              >
                <button
                  type="button"
                  className="pass-hit"
                  aria-pressed={on}
                  aria-label={`${on ? "Remove the favourite of" : "Favourite"} the moment at ${timeOf(m.captured_at)}`}
                  onClick={() => tap(m)}
                >
                  <Thumb frame={cover} />
                  <span className="pass-time">{timeOf(m.captured_at)}</span>
                  {hint && <span className="pass-why">{hint}</span>}
                  {on && (
                    <span className="pass-heart">
                      <HeartIcon filled size={15} />
                      {favIds(m).length > 1 && favIds(m).length}
                    </span>
                  )}
                </button>
                {m.ids.length > 1 && (
                  <button
                    type="button"
                    className="pass-stack"
                    title={`${m.ids.length} frames — choose which one`}
                    aria-label={`Open the ${m.ids.length} frames of this moment`}
                    onClick={() => setOpen(i)}
                  >
                    ×{m.ids.length}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="pass-foot">
        <Link href={`/sessions/${id}`} className="btn btn-primary pass-done">
          Done · {count} favourite{count === 1 ? "" : "s"}
        </Link>
        <span className="pass-foot-note">Tap what you like. The rest stays as it is: nothing is rejected.</span>
      </div>

      {sheet && (
        <MomentSheet
          moment={sheet}
          frames={frameById}
          fav={fav}
          onToggle={(fid) => void write([fid], !fav.get(fid))}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// Every frame of one moment, to put the ♥ on the right one. A modal on a
// desktop, a bottom sheet on a phone (the body chooser's shell).
function MomentSheet({
  moment,
  frames,
  fav,
  onToggle,
  onClose,
}: {
  moment: Moment;
  frames: Map<number, PassFrame>;
  fav: Map<number, boolean>;
  onToggle: (id: number) => void;
  onClose: () => void;
}) {
  const backdrop = useOverlayDismiss<HTMLDivElement>(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = `${moment.ids.length} frames at ${timeOf(moment.captured_at)}`;
  return (
    <div className="modal-backdrop body-chooser-backdrop" {...backdrop}>
      <div className="modal body-chooser pass-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="body-chooser-head">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="pass-sheet-grid">
          {moment.ids.map((fid) => {
            const f = frames.get(fid);
            const on = !!fav.get(fid);
            return (
              <button
                key={fid}
                type="button"
                className={`pass-tile pass-hit${on ? " on" : ""}`}
                aria-pressed={on}
                aria-label={on ? "Remove from favourites" : "Add to favourites"}
                onClick={() => onToggle(fid)}
              >
                <Thumb frame={f} />
                {f && f.verdict === "pick" && <span className="pass-why">Pick</span>}
                {on && (
                  <span className="pass-heart">
                    <HeartIcon filled size={15} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
