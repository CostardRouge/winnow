// Network helpers for the common per-asset / bulk actions (rate, tag, delete,
// export). The host components (gallery shell, session grid) keep their own
// optimistic local state; these only own the API calls so the three surfaces —
// context menu, detailed viewer, bulk selection — stay consistent and DRY.
import type { Verdict } from "./types";

const HEADERS = { "Content-Type": "application/json" };

// Pick / reject / clear verdict and/or stars. Works for one (ids:[id]) or many.
// `expandBursts` widens each id to its whole burst pile server-side (every live
// frame + pair companions) — the explicit "cull the pile in one gesture" action
// (cf. lib/bursts.ts); never set it from an ordinary single-frame rating.
export async function rateAssets(
  ids: number[],
  patch: { verdict?: Verdict; star?: number },
  opts: { expandBursts?: boolean } = {},
): Promise<void> {
  if (!ids.length || (patch.verdict == null && patch.star == null)) return;
  await fetch("/api/ratings/bulk", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      ids,
      ...patch,
      ...(opts.expandBursts ? { expand_bursts: true } : {}),
    }),
  });
}

// Pull the indexed original (abs_path) for a single asset down to the browser as
// an attachment. Goes straight at the /download route — which streams the real
// file even when no derivative exists yet — so you can inspect a Pending/failed
// item that has no preview. Triggered through a throwaway anchor so the current
// page isn't navigated away from.
export function downloadAssetOriginal(id: number): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = `/api/assets/${id}/download`;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// One file the Download menu can pull: the name to save it under and the URL the
// browser hits to fetch the bytes (a per-file download endpoint). Shared by the
// session media download (originals) and the export download (copied output) so
// the same dropdown drives both even though the sources differ.
export type DownloadFile = { filename: string; href: string };

// The flat manifest of a session's downloadable originals, mapped to the shape
// the Download menu consumes: each non-deleted asset pulled through its own
// /download endpoint (which streams the original even with no derivative yet).
export async function sessionDownloadFiles(
  sessionId: number,
): Promise<DownloadFile[]> {
  const res = await fetch(`/api/sessions/${sessionId}/files`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Couldn’t list files (${res.status})`);
  }
  const body = (await res.json()) as {
    files?: { id: number; filename: string }[];
    sidecars?: { id: number; filename: string }[];
  };
  const files = (body.files ?? []).map((f) => ({
    filename: f.filename,
    href: `/api/assets/${f.id}/download`,
  }));
  // Video sidecars (Sony XML/THM, DJI .SRT) travel with their clip: pull each
  // through its own endpoint so "each file" / "save to folder" carry them too.
  const sidecars = (body.sidecars ?? []).map((s) => ({
    filename: s.filename,
    href: `/api/sidecars/${s.id}/download`,
  }));
  return [...files, ...sidecars];
}

// The per-file manifest of an ad-hoc grid selection, built from the rows the
// grid already holds (no extra fetch): each asset through its own /download
// endpoint, any sidecars the row carries riding along — the same shape the
// session manifest resolves to, so the shared Download menu drives both.
export function selectionDownloadFiles(
  rows: {
    id: number;
    filename: string;
    sidecars?: { id: number; filename: string }[] | null;
  }[],
): DownloadFile[] {
  return rows.flatMap((a) => [
    { filename: a.filename, href: `/api/assets/${a.id}/download` },
    ...(a.sidecars ?? []).map((s) => ({
      filename: s.filename,
      href: `/api/sidecars/${s.id}/download`,
    })),
  ]);
}

// The matching whole-selection ZIP URL (api/assets/download): every id in the
// query string, streamed back as one archive with the sidecars included.
export function selectionZipHref(ids: number[]): string {
  return `/api/assets/download?ids=${ids.join(",")}`;
}

// Add (or remove) a single tag by name across the given assets.
export async function tagAssets(
  ids: number[],
  name: string,
  add: boolean,
): Promise<void> {
  const tag = name.trim();
  if (!ids.length || !tag) return;
  await fetch("/api/tags/assign", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, [add ? "add" : "remove"]: [tag] }),
  });
}

// Soft delete (or restore). Hides from the library; never touches the original.
export async function deleteAssets(
  ids: number[],
  restore = false,
): Promise<void> {
  if (!ids.length) return;
  await fetch("/api/assets/delete", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, restore }),
  });
}

// Soft delete (or restore) every asset matching a filter — e.g.
// `{ verdict: "reject" }` to send all rejects to the trash, or `{}` + restore to
// empty the recycle bin back into the library. Returns how many rows moved.
export async function deleteAssetsByFilter(
  filter: Record<string, unknown>,
  restore = false,
): Promise<number> {
  const res = await fetch("/api/assets/delete", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ filter, restore }),
  });
  const body = (await res.json().catch(() => ({}))) as { updated?: number };
  return body.updated ?? 0;
}

// Reclaim space: physically remove the trashed originals + derivatives. With
// `dryRun` it only measures the selection ({ count, bytes }); otherwise it
// queues a purge job and returns its id. Irreversible — callers confirm first.
export async function purgeTrash(
  filter: Record<string, unknown> = {},
  dryRun = false,
): Promise<{ count?: number; bytes?: number; purge_job_id?: number }> {
  const res = await fetch("/api/purge", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ filter, dryRun }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Purge failed (${res.status})`);
  }
  return res.json();
}

// Rebuilds the derivatives (thumb + proxy) of the given assets — resets them to
// 'pending' and re-enqueues generation, whatever their current status. Works for
// one (ids:[id]) or many. Returns how many were actually queued, or throws on a
// non-2xx response.
export async function regenerateAssets(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/regenerate", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Regenerate failed (${res.status})`);
  }
  const body = (await res.json()) as { queued: number };
  return body.queued;
}

// Resolves place names (country / région / département / city, plus a tourist
// POI) for these assets from their GPS coordinates. Defaults to a precise,
// exact-coordinate lookup (fills the POI) since it's hand-triggered. Works for
// one (ids:[id]) or many. Returns how many were actually queued (assets without
// coordinates are skipped), or throws on a non-2xx response.
export async function geocodeAssets(
  ids: number[],
  opts: { precise?: boolean } = {},
): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/geocode", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, precise: opts.precise }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Resolve location failed (${res.status})`);
  }
  const body = (await res.json()) as { queued: number };
  return body.queued;
}

// How a human-set position came to be (cf. api/assets/geotag, docs/UNPLACED.md
// §4.2): a pin placed knowing the place, or a folder-scale suggestion accepted
// in bulk. Only 'manual' is ever written back into the original file.
export type GeotagSource = "manual" | "inferred";

// Sets the GPS position of these assets by hand (the geotag action — cf.
// api/assets/geotag): updates the DB, re-resolves the place names and, for a
// 'manual' pin, queues the EXIF write-back into the originals. The caller
// (GeotagRecapModal) has already had the user confirm the per-asset
// before/after, including any overwrite of an existing position. Works for one
// (ids:[id]) or many. Returns how many rows were actually updated, or throws on
// a non-2xx response.
export async function geotagAssets(
  ids: number[],
  gps: { lat: number; lon: number },
  source: GeotagSource = "manual",
): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/geotag", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, lat: gps.lat, lon: gps.lon, source }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Geotag failed (${res.status})`);
  }
  const body = (await res.json()) as { updated: number };
  return body.updated;
}

// Marks these assets as never needing a position (exempt=true) or returns
// them to the geotag backlog (cf. api/assets/geo-exempt). Returns how many
// rows changed.
export async function exemptAssets(
  ids: number[],
  exempt: boolean,
): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/geo-exempt", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, exempt }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ?? `${exempt ? "Exempt" : "Un-exempt"} failed (${res.status})`,
    );
  }
  const body = (await res.json()) as { updated: number };
  return body.updated;
}

// What the geotag recap modal needs to know about one media (a subset of the
// grid row). Kept here so the session-level flows (sessions list, session
// header, the Unplaced view) and the grid flows share one shape. The optional
// tail (`geo_exempt_at`, `camera_model`, `lens`) rides along when the source
// is a full grid row — the Unplaced view reads it to leave exempted media out
// of a bulk apply and to spot the no-camera-EXIF ones (likely screenshots).
export type GeotagAsset = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  gps: { lat: number; lon: number } | null;
  gps_source?: GeotagSource | null;
  place_city?: string | null;
  place_country?: string | null;
  geo_exempt_at?: string | null;
  camera_model?: string | null;
  lens?: string | null;
};

// Every live, non-exempt media of these sessions, in the recap shape — the
// entry points that have no asset grid loaded start here: the Geotag action on
// a session card and on the session page's header (one session), and the
// Unplaced view's Place (a folder group, several). ONE unpaged request to
// api/assets/geotag/targets, which returns exactly these nine columns; it used
// to page through the session assets route for the full grid projection, eight
// requests for a large folder.
//
// Throws when the answer is truncated rather than returning a subset: a recap
// that silently lists 20 000 of 25 000 media would write 20 000 and look like
// it was done.
//
// `window` narrows the folders to the media captured inside it, inclusive —
// how one PART of a container folder (a month, a year; docs/UNPLACED.md §9) is
// placed without fetching the whole folder. Sent as canonical ISO instants
// whatever the caller holds (pg's own text form is not ISO).
export async function geotagTargets(
  sessionIds: number[],
  window?: { from: string; to: string },
): Promise<GeotagAsset[]> {
  if (!sessionIds.length) return [];
  const sp = new URLSearchParams({ session_ids: sessionIds.join(",") });
  if (window) {
    sp.set("captured_from", new Date(window.from).toISOString());
    sp.set("captured_to", new Date(window.to).toISOString());
  }
  const res = await fetch(`/api/assets/geotag/targets?${sp}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Couldn’t list the media (${res.status})`);
  }
  const body = (await res.json()) as {
    assets?: GeotagAsset[];
    truncated?: boolean;
  };
  if (body.truncated) {
    throw new Error(
      "Too many media to geotag in one go — narrow the selection and try again.",
    );
  }
  return body.assets ?? [];
}

// One place suggestion returned by the geotag autocomplete (cf.
// api/places/search): the provider's display name + the coordinate to jump to.
export type PlaceSuggestion = { display_name: string; lat: number; lon: number };

// Searches place names for the geotag autocomplete (debounced by the caller).
export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const res = await fetch(
    `/api/places/search?q=${encodeURIComponent(trimmed)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Place search failed (${res.status})`);
  }
  const body = (await res.json()) as { results: PlaceSuggestion[] };
  return body.results ?? [];
}

// (Re)runs the ML analysis — face detection + OCR text read off the derivative
// (cf. lib/ml.ts) — for these assets. Works for one (ids:[id]) or many. Returns
// how many were actually queued (assets without a derivative yet are skipped),
// or throws on a non-2xx response (e.g. ML_ENABLED=false).
export async function mlAnalyzeAssets(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/ml", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Detect faces & text failed (${res.status})`);
  }
  const body = (await res.json()) as { queued: number };
  return body.queued;
}

// Takes assets out of the analyze pipeline (derivative_status -> 'skipped') so a
// stuck/unwanted item stops being processed. Reversible via regenerateAssets.
export async function skipAssets(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/skip", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Skip failed (${res.status})`);
  }
  const body = (await res.json()) as { skipped: number };
  return body.skipped;
}

// Ad-hoc exports now go through ExportSelectionModal (dynamic file picker) —
// see app/exports/ExportSelectionModal.tsx — which POSTs /api/export itself
// with the per-category `include` map.
