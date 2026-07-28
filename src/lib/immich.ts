// Immich client — the `immich` export target (cf. lib/export.ts).
//
// Why this exists: Winnow is the darkroom (index in place, cull on proxies,
// never touch the RAWs), Immich is the archive everyone actually browses from
// their phone. The NAS "final" folders Winnow indexes read-only ARE Immich's
// output (cf. config.ts FINALS_DIRS), so the last step of a winnowing is
// naturally "send the keepers over". This module is that step.
//
// What it deliberately does NOT do: write into Immich's storage, its database
// or its filesystem layout. Everything goes through the documented, versioned
// REST API (openapi 3.1.0 at the time of writing) with an ordinary API key, so
// an Immich upgrade can't silently corrupt anything — the worst case is an HTTP
// error surfaced on the export job. (Contrast lib/ml.ts, which speaks the
// INTERNAL machine-learning endpoint and has to pin a container tag.)
//
// Dedup is Immich's, by checksum: uploading a file it already holds returns the
// EXISTING asset id with status 'duplicate' instead of creating a second copy.
// That makes a re-run of an export idempotent for free; IMMICH_PRECHECK only
// makes it cheaper by asking before sending the bytes.
import { openAsBlob } from "node:fs";
import { config } from "./config";

export type ImmichUploadStatus = "created" | "duplicate";

export type ImmichUploadResult = {
  id: string;
  status: ImmichUploadStatus;
};

// True when the target is usable at all. The API key is enforced at boot
// (config.ts superRefine), so `enabled` is the only thing left to check.
export function immichConfigured(): boolean {
  return config.immich.enabled;
}

// The API root. Immich serves everything under /api; the configured base is the
// server root so the same value works for a browser link to the library.
function apiBase(): string {
  return `${config.immich.baseUrl.replace(/\/+$/, "")}/api`;
}

// Deep link to an uploaded asset, for the export card. Not an API path.
export function immichAssetUrl(assetId: string): string {
  return `${config.immich.baseUrl.replace(/\/+$/, "")}/photos/${assetId}`;
}

export function immichAlbumUrl(albumId: string): string {
  return `${config.immich.baseUrl.replace(/\/+$/, "")}/albums/${albumId}`;
}

// One JSON call. Errors carry the server's own message when it sends one — an
// Immich 400 explains itself far better than "HTTP 400" does in a job result.
async function call<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method,
    headers: {
      "x-api-key": config.immich.apiKey,
      accept: "application/json",
      ...(init.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(config.immich.timeoutMs),
  });
  if (!res.ok) throw new Error(await httpError(res, path));
  // 204s (and empty bodies) are valid successes for some endpoints.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function httpError(res: Response, path: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === "string") detail = ` — ${body.message}`;
    else if (Array.isArray(body?.message))
      detail = ` — ${body.message.join("; ")}`;
  } catch {
    // Non-JSON body (a proxy's HTML error page): the status alone will do.
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (check IMMICH_API_KEY)"
      : res.status === 404
        ? " (check IMMICH_BASE_URL — it must NOT include /api)"
        : "";
  return `immich HTTP ${res.status} on ${path}${hint}${detail}`;
}

// Liveness + credentials probe, used by GET /api/export/targets so the export
// modal can say "Immich unreachable" before a job is queued rather than after.
// /server/ping is unauthenticated, so it only proves the URL; the album listing
// right after is what proves the key.
export async function immichPing(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${apiBase()}/server/ping`, {
      headers: { accept: "application/json" },
      // Short: this one runs while a modal waits, not inside a worker.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: await httpError(res, "/server/ping") };
    const me = await fetch(`${apiBase()}/albums`, {
      headers: { "x-api-key": config.immich.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!me.ok) return { ok: false, error: await httpError(me, "/albums") };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// --- Pre-flight dedup -------------------------------------------------------

export type UploadCheckItem = { id: string; checksum: string };

// Ask Immich which of these SHA-1s it already holds. Returns id → existing
// asset id for the ones it does. `action` is 'reject' with reason 'duplicate'
// when the file is known — anything else (including an unsupported format) is
// left to the upload, which reports a real error we can show per file.
//
// A trashed duplicate is deliberately NOT treated as present: its asset id is
// still valid, but the media is in Immich's bin, so re-uploading is what the
// user meant by pushing it again.
export async function immichCheckUploads(
  items: UploadCheckItem[],
): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  if (!items.length) return known;

  // Bounded batches: the list is one line per file and a session export can be
  // thousands of them.
  const BATCH = 500;
  for (let i = 0; i < items.length; i += BATCH) {
    const data = await call<{
      results?: Array<{
        id: string;
        action: string;
        assetId?: string;
        isTrashed?: boolean;
        reason?: string;
      }>;
    }>("/assets/bulk-upload-check", {
      method: "POST",
      body: { assets: items.slice(i, i + BATCH) },
    });
    for (const r of data?.results ?? []) {
      if (
        r.action === "reject" &&
        r.reason === "duplicate" &&
        r.assetId &&
        !r.isTrashed
      ) {
        known.set(r.id, r.assetId);
      }
    }
  }
  return known;
}

// --- Upload -----------------------------------------------------------------

export type UploadInput = {
  absPath: string;
  filename: string;
  /** When the shot was taken (falls back to the file's mtime upstream). */
  createdAt: Date;
  modifiedAt: Date;
  /** Hex SHA-1, when already computed — lets Immich short-circuit duplicates. */
  checksum?: string;
  /**
   * Immich asset id of the .mov this still belongs to, so an iPhone Live Photo
   * lands in Immich AS a Live Photo instead of a JPEG and an unrelated clip.
   * Winnow already treats the pair as one logical media (cf. lib/pairing.ts) —
   * this is what carries that across.
   */
  livePhotoVideoId?: string;
};

export async function immichUpload(
  input: UploadInput,
): Promise<ImmichUploadResult> {
  // openAsBlob streams from disk: a 60 MB RAW is never buffered in the worker's
  // heap (which is what a readFile + Blob would do, times EXPORT_CONCURRENCY).
  const blob = await openAsBlob(input.absPath);
  const form = new FormData();
  form.set("assetData", blob, input.filename);
  form.set("filename", input.filename);
  form.set("fileCreatedAt", input.createdAt.toISOString());
  form.set("fileModifiedAt", input.modifiedAt.toISOString());
  if (input.livePhotoVideoId)
    form.set("livePhotoVideoId", input.livePhotoVideoId);

  const res = await fetch(`${apiBase()}/assets`, {
    method: "POST",
    headers: {
      "x-api-key": config.immich.apiKey,
      accept: "application/json",
      // Lets the server recognize a duplicate without hashing the upload again.
      ...(input.checksum ? { "x-immich-checksum": input.checksum } : {}),
    },
    body: form,
    signal: AbortSignal.timeout(config.immich.timeoutMs),
  });
  if (!res.ok) throw new Error(await httpError(res, "/assets"));

  const data = (await res.json()) as { id?: string; status?: string };
  if (!data?.id) throw new Error("immich upload returned no asset id");
  return {
    id: data.id,
    status: data.status === "duplicate" ? "duplicate" : "created",
  };
}

// --- Albums -----------------------------------------------------------------

export type ImmichAlbum = { id: string; albumName: string };

// Reuse an album of that name if the key's owner already has one, else create
// it. Re-exporting the same session therefore tops up one album instead of
// littering the library with "session-picks (2)".
export async function immichFindOrCreateAlbum(
  name: string,
): Promise<ImmichAlbum> {
  const albums = await call<ImmichAlbum[]>("/albums");
  const existing = (albums ?? []).find((a) => a.albumName === name);
  if (existing) return { id: existing.id, albumName: existing.albumName };

  const created = await call<ImmichAlbum>("/albums", {
    method: "POST",
    body: { albumName: name, description: "Pushed from Winnow" },
  });
  return { id: created.id, albumName: created.albumName };
}

// Add assets to an album. Immich answers per id, and an asset already in the
// album comes back as a `duplicate` failure — which is a success for us, so
// only genuine errors are returned.
export async function immichAddToAlbum(
  albumId: string,
  assetIds: string[],
): Promise<string[]> {
  const errors: string[] = [];
  const BATCH = 500;
  for (let i = 0; i < assetIds.length; i += BATCH) {
    const results = await call<
      Array<{ id: string; success: boolean; error?: string }>
    >(`/albums/${albumId}/assets`, {
      method: "PUT",
      body: { ids: assetIds.slice(i, i + BATCH) },
    });
    for (const r of results ?? []) {
      if (!r.success && r.error !== "duplicate")
        errors.push(`${r.id}: ${r.error ?? "unknown error"}`);
    }
  }
  return errors;
}
