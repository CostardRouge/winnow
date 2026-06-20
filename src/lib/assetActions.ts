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
// existing export pipeline via the new `ids` filter). Returns the job id, or
// throws on a non-2xx response.
export async function exportAssets(ids: number[]): Promise<number> {
  if (!ids.length) throw new Error("No assets to export");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const name =
    ids.length === 1 ? `Export ${stamp}` : `Selection ${ids.length} · ${stamp}`;
  const res = await fetch("/api/export", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name, target: "capture_one", filter: { ids } }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed (${res.status})`);
  }
  const body = (await res.json()) as { export_job_id: number };
  return body.export_job_id;
}
