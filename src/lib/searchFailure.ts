// What the Search page says when /api/search does not answer with results.
//
// The route answers JSON in every case it reaches (`api/search/route.ts`): the
// index off (`enabled: false`), a bad query (400), the ML container failing to
// read the words (502 `embedding failed` + its detail), anything else (500).
// But on the Optiplex Cloudflare sits in front and REPLACES a 502/504 with its
// own HTML page, and a hung ML container makes the request outlive Cloudflare's
// 100 s (524) — so the page used to call `res.json()` on HTML and showed
// «Unexpected token '<', "<!DOCTYPE"…», which says nothing. Found 2026-11-03
// when immich-machine-learning had hung for a week (docs/memory/pipeline.md).
//
// Pure: no DOM, no fetch — the page hands it the status and the body text.

/** Statuses a gateway (Traefik, Cloudflare) answers on its own when the origin or what it calls is down or slow. */
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

const ML_HINT =
  "check that the immich-machine-learning container is up and that ML_BASE_URL reaches it — Settings › Pipeline › Faces & text lists the analyses that failed meanwhile";

/** The body as JSON when it is JSON, else null — a gateway's HTML page is not. */
export function readJson(body: string): Record<string, unknown> | null {
  const text = body.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One sentence for a failed search, from the answer's status and body. */
export function searchFailureMessage(status: number, body: string): string {
  const data = readJson(body);
  const said = (key: string) => (typeof data?.[key] === "string" && (data[key] as string).trim() ? (data[key] as string).trim() : null);
  if (data) {
    if (said("error") === "embedding failed") {
      return `The ML container could not read the words${said("detail") ? ` (${said("detail")})` : ""} — ${ML_HINT}.`;
    }
    return said("detail") ?? said("error") ?? `Search failed (HTTP ${status}).`;
  }
  if (GATEWAY.has(status)) {
    return `The server answered through its gateway with HTTP ${status}: the ML container did not answer in time — ${ML_HINT}.`;
  }
  return `Search failed (HTTP ${status}).`;
}
