// Network helpers for the common per-asset / bulk actions (rate, tag, delete,
// export). The host components (gallery shell, session grid) keep their own
// optimistic local state; these only own the API calls so the three surfaces —
// context menu, detailed viewer, bulk selection — stay consistent and DRY.
import type { Verdict } from "./types";

const HEADERS = { "Content-Type": "application/json" };

// Pick / reject / clear verdict and/or stars. Works for one (ids:[id]) or many.
export async function rateAssets(
  ids: number[],
  patch: { verdict?: Verdict; star?: number },
): Promise<void> {
  if (!ids.length || (patch.verdict == null && patch.star == null)) return;
  await fetch("/api/ratings/bulk", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, ...patch }),
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

// Manually sets the GPS position of these assets (the geotag action — cf.
// api/assets/geotag): updates the DB, re-resolves the place names and queues
// the EXIF write-back into the originals. The caller (GeotagRecapModal) has
// already had the user confirm the per-asset before/after, including any
// overwrite of an existing position. Works for one (ids:[id]) or many. Returns
// how many rows were actually updated, or throws on a non-2xx response.
export async function geotagAssets(
  ids: number[],
  gps: { lat: number; lon: number },
): Promise<number> {
  if (!ids.length) return 0;
  const res = await fetch("/api/assets/geotag", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ ids, lat: gps.lat, lon: gps.lon }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Geotag failed (${res.status})`);
  }
  const body = (await res.json()) as { updated: number };
  return body.updated;
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

// Queues a RAW-copy export job scoped to exactly these asset ids (reuses the
// existing export pipeline via the new `ids` filter). The worker exports each
// pair's keeper by default (RAW+JPEG → the RAW; Live Photo → the still); pass
// `includeJpeg` / `includeLiveVideo` to also copy the companion extra (omitted →
// the server falls back to the persisted preference). Returns the job id, or
// throws on a non-2xx response.
export async function exportAssets(
  ids: number[],
  opts: { includeJpeg?: boolean; includeLiveVideo?: boolean } = {},
): Promise<number> {
  if (!ids.length) throw new Error("No assets to export");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const name =
    ids.length === 1 ? `Export ${stamp}` : `Selection ${ids.length} · ${stamp}`;
  const params: Record<string, boolean> = {};
  if (opts.includeJpeg !== undefined) params.include_jpeg = opts.includeJpeg;
  if (opts.includeLiveVideo !== undefined)
    params.include_live_video = opts.includeLiveVideo;
  const res = await fetch("/api/export", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name, target: "capture_one", filter: { ids }, params }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed (${res.status})`);
  }
  const body = (await res.json()) as { export_job_id: number };
  return body.export_job_id;
}
