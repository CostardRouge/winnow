// Winnow's commands: what an agent may do to the library, each one a call to
// the very API route the UI's gesture calls.
//
// That last clause is the whole security model, and why the MCP server is a
// CLIENT of the API (`src/scripts/mcp.ts`) rather than an endpoint inside
// Winnow: every command below goes through `src/proxy.ts` with the agent's
// app token, so the token's ceiling (viewer or editor, never admin), the
// API-only rule, the role policy of lib/authz.ts, the feature flags and the
// routes' own validation all apply exactly as they do to Atelier or to a
// browser. Nothing here decides who may do what; `available()` only says
// ahead of time what the server would refuse, so an agent is not offered a
// verb its token cannot use. A write made this way is stamped as an agent's
// when the token was minted for one (migration 0048, `ratings.rated_via`).
//
// Answers are trimmed for an agent's context: a grid row is ~2.5 KB of
// columns a person never reads, so lists carry a summary and `assets.get`
// the whole row. Pure apart from the injected client — tests pass a fake.
import {
  CommandError,
  type Availability,
  type CommandSpec,
  type ImageResult,
} from "./registry";
import { imageSize } from "./imageSize";

// ---------------------------------------------------------------------------
// The HTTP client the commands call through.

export interface WinnowClient {
  /** The instance's address, for the agent's benefit (`app.status`). */
  readonly base: string;
  json<T>(method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<T>;
  bytes(path: string): Promise<Uint8Array>;
}

/** A non-2xx answer, with the server's own `{ error }` text when it sent one. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function failure(res: Response, path: string): Promise<HttpError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; details?: unknown };
    if (typeof body.error === "string") detail = body.error;
    if (body.details !== undefined) detail += ` — ${JSON.stringify(body.details)}`;
  } catch {
    // not JSON: the status says enough
  }
  return new HttpError(res.status, `${path}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
}

/**
 * The real client: `Authorization: Bearer <token>` on every call, which is
 * what makes every command a request the proxy checks like any other.
 */
export function httpClient(
  base: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): WinnowClient {
  const root = base.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  return {
    base: root,
    async json(method, path, body) {
      const res = await fetchImpl(`${root}${path}`, {
        method,
        headers:
          body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw await failure(res, path);
      return (await res.json()) as never;
    },
    async bytes(path) {
      const res = await fetchImpl(`${root}${path}`, { headers });
      if (!res.ok) throw await failure(res, path);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---------------------------------------------------------------------------
// What the instance says about this token, asked once and kept a little while
// (a role change applies on the server at once; here it shows within the TTL).

type Me = { user: { id: number; username: string; displayName: string | null; role: string; via: string | null } };
type Capabilities = { api: { version: number }; media: { timeline?: boolean } };

const STATUS_TTL_MS = 30_000;

function statusCache(client: WinnowClient) {
  let at = 0;
  let value: Promise<{ me: Me; caps: Capabilities }> | null = null;
  return () => {
    if (!value || Date.now() - at > STATUS_TTL_MS) {
      at = Date.now();
      value = Promise.all([
        client.json<Me>("GET", "/api/auth/me"),
        client.json<Capabilities>("GET", "/api/capabilities"),
      ]).then(([me, caps]) => ({ me, caps }));
      value.catch(() => {
        value = null; // never cache a failure
      });
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// Parameter helpers the subset cannot say (a date's shape, a span's length).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key] as string | undefined;
  if (v === undefined) return undefined;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
    throw new CommandError("invalid", `"${key}" is "${v}" — a day as YYYY-MM-DD`);
  return v;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

const MAX_SPAN_DAYS = 366;

function query(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Row shapes, as the API answers them (only what is read here).

type GridRow = {
  id: number;
  filename: string;
  ext: string;
  media_type: string;
  rel_path: string;
  session_id: number;
  captured_at: string | null;
  capture_date: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  device: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal_length: number | null;
  place_city: string | null;
  place_country: string | null;
  place_poi: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  derivative_status: string;
  verdict: string;
  star: number;
  color_label: string | null;
  rated_via?: string | null;
  tags: string[];
  companion_id: number | null;
  group_kind: string | null;
  burst_id: number | null;
  burst_count: number | null;
  burst_kind: string | null;
  face_count: number | null;
  sharpness: number | null;
};

/** One line of a list: what a person culling a day would read off a tile. */
export function summarize(a: GridRow) {
  const place = [a.place_poi, a.place_city, a.place_country].filter(Boolean).join(", ");
  return {
    id: a.id,
    file: a.filename,
    type: a.media_type,
    captured_at: a.captured_at,
    // `capture_date` is a SQL date that node-postgres hands over as a JS Date
    // at the server's midnight, so it reaches JSON as "2025-01-04T00:00:00.000Z"
    // (the instance runs in UTC). The day is the first ten characters.
    day: a.capture_date ? String(a.capture_date).slice(0, 10) : null,
    ...(a.width && a.height ? { size: `${a.width}×${a.height}` } : {}),
    ...(a.duration_s ? { duration_s: Math.round(a.duration_s) } : {}),
    camera: a.camera_model ?? a.device ?? null,
    ...(a.lens ? { lens: a.lens } : {}),
    exposure:
      [
        a.focal_length ? `${a.focal_length}mm` : null,
        a.aperture ? `f/${a.aperture}` : null,
        a.shutter ? `${a.shutter}s` : null,
        a.iso ? `ISO ${a.iso}` : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    place: place || null,
    culling: {
      verdict: a.verdict,
      star: a.star,
      color: a.color_label,
      ...(a.rated_via ? { by: a.rated_via } : {}),
    },
    ...(a.tags?.length ? { tags: a.tags } : {}),
    ...(a.companion_id ? { pair: { kind: a.group_kind, companion_id: a.companion_id } } : {}),
    ...(a.burst_id
      ? { burst: { id: a.burst_id, kind: a.burst_kind, frames: a.burst_count } }
      : {}),
    ...(a.face_count ? { faces: a.face_count } : {}),
    ...(a.derivative_status !== "ready" ? { derivative: a.derivative_status } : {}),
  };
}

type Chapter = {
  key: string;
  name: string;
  started_at: string;
  ended_at: string;
  count: number;
  places: string[];
  devices: string[];
  tz_offset_hours: number | null;
  place_inferred: boolean;
  cover_id: number | null;
  sample_ids: number[];
};

// The colour labels a cull uses — Lightroom's five. `color_label` is free
// text in the schema (0001) and no screen writes it yet, so an agent is held
// to the five a person would recognise; "none" clears it.
export const COLOR_LABELS = ["red", "yellow", "green", "blue", "purple", "none"] as const;

export const VERDICTS = ["pick", "reject", "skip", "unrated"] as const;

// ---------------------------------------------------------------------------

export function winnowCommands(client: WinnowClient): CommandSpec[] {
  const status = statusCache(client);

  const canWrite = async (): Promise<Availability> => {
    const { me } = await status();
    if (me.user.role === "editor" || me.user.role === "admin") return true;
    return `this token reads only (it runs as ${me.user.role}): an admin mints an editor token on Users › App tokens for an agent that may cull`;
  };

  const timelineOn = async (): Promise<Availability> => {
    const { caps } = await status();
    return caps.media.timeline === true
      ? true
      : "the Timeline is turned off on this instance (Settings › Features) — use library.days";
  };

  return [
    {
      id: "app.status",
      title: "Status",
      description:
        "Who this agent is on the instance and what it may do: the account it acts as, the role its token runs as (viewer reads, editor may also cull), whether its writes are marked as an agent's, and which optional readings (the Timeline) the instance offers. Call it first.",
      async run() {
        const { me, caps } = await status();
        const role = me.user.role;
        return {
          instance: client.base,
          api: caps.api.version,
          actsAs: me.user.username,
          role,
          via: me.user.via,
          writes: role === "editor" || role === "admin",
          markedAsAgent: me.user.via === "agent",
          timeline: caps.media.timeline === true,
        };
      },
    },

    {
      id: "library.days",
      title: "Days",
      description:
        "The capture days between two dates with how many media each holds (RAW+JPEG pairs count once) and a cover asset id, plus `bounds`: the first and last day of the whole library. A span is at most 366 days. Days are the place's local day.",
      params: {
        from: { type: "string", description: "First day, YYYY-MM-DD" },
        to: { type: "string", description: "Last day, YYYY-MM-DD (at most 366 days after from)" },
        kind: {
          type: "string",
          enum: ["incoming", "final"],
          optional: true,
          description: "incoming = the cull's material, final = the delivered gallery; both when absent",
        },
      },
      async run(p) {
        const from = date(p, "from")!;
        const to = date(p, "to")!;
        const span = daysBetween(from, to);
        if (span < 0) throw new CommandError("invalid", `"to" (${to}) is before "from" (${from})`);
        if (span > MAX_SPAN_DAYS)
          throw new CommandError("invalid", `${span} days asked — ${MAX_SPAN_DAYS} at most; page by year`);
        return client.json("GET", `/api/assets/calendar${query({ from, to, kind: p.kind as string | undefined })}`);
      },
    },

    {
      id: "library.chapters",
      title: "Chapters",
      description:
        "The library read as a story: chapters (a stay in a place, or a run of days) with their dates, places, devices, media count, a cover id and a few sample ids. Only when the instance's Timeline is on.",
      available: timelineOn,
      params: {
        from: { type: "string", optional: true, description: "First day, YYYY-MM-DD" },
        to: { type: "string", optional: true, description: "Last day, YYYY-MM-DD" },
        mode: {
          type: "string",
          enum: ["place", "time", "hybrid"],
          optional: true,
          description: "How chapters are cut (the instance's default when absent)",
        },
      },
      async run(p) {
        const r = await client.json<{ chapters: Chapter[]; undated: number; granularity: string }>(
          "GET",
          `/api/assets/timeline${query({
            date_from: date(p, "from"),
            date_to: date(p, "to"),
            mode: p.mode as string | undefined,
          })}`,
        );
        return {
          granularity: r.granularity,
          undated: r.undated,
          chapters: r.chapters.map((c) => ({
            key: c.key,
            name: c.name,
            started_at: c.started_at,
            ended_at: c.ended_at,
            count: c.count,
            places: c.places,
            devices: c.devices,
            tz_offset_hours: c.tz_offset_hours,
            place_inferred: c.place_inferred,
            cover_id: c.cover_id,
            sample_ids: c.sample_ids,
          })),
        };
      },
    },

    {
      id: "assets.list",
      title: "List media",
      description:
        "Media in capture order with their culling (verdict, stars, colour, and `by: agent` when an agent set it), newest first unless `order` says otherwise. Filter by a day or a span, a verdict, a minimum star count, a type or a search. One line per RAW+JPEG pair and per burst pile by default (`fold: all`); `fold: pairs` lists every frame of a pile, and `burst` lists one pile's frames. Pages with `cursor` (the `next_cursor` of the previous page).",
      params: {
        day: { type: "string", optional: true, description: "One capture day, YYYY-MM-DD (or use from/to)" },
        from: { type: "string", optional: true, description: "First day, YYYY-MM-DD" },
        to: { type: "string", optional: true, description: "Last day, YYYY-MM-DD" },
        verdict: { type: "string", enum: VERDICTS, optional: true, description: "Only media with this verdict" },
        star_min: { type: "number", integer: true, min: 0, max: 5, optional: true, description: "At least this many stars" },
        type: { type: "string", enum: ["photo", "video"], optional: true, description: "Photos or videos only" },
        kind: { type: "string", enum: ["incoming", "final"], optional: true, description: "incoming = the cull's material, final = the delivered gallery" },
        search: { type: "string", optional: true, description: "Words matched against names, places, camera, text in the picture" },
        burst: { type: "number", integer: true, min: 1, optional: true, description: "One burst pile's id: every frame of it" },
        fold: { type: "string", enum: ["all", "pairs"], optional: true, description: "all (default): a pair or a pile is one line; pairs: every frame of a pile" },
        order: { type: "string", enum: ["newest", "oldest"], optional: true, description: "newest (default) or oldest first" },
        limit: { type: "number", integer: true, min: 1, max: 200, optional: true, description: "Page size, 50 by default" },
        cursor: { type: "string", optional: true, description: "next_cursor from the previous page" },
      },
      async run(p) {
        const day = date(p, "day");
        if (day && (p.from !== undefined || p.to !== undefined))
          throw new CommandError("invalid", `"day" or "from"/"to", not both`);
        const r = await client.json<{ assets: GridRow[]; next_cursor: string | null }>(
          "GET",
          `/api/assets${query({
            date_from: day ?? date(p, "from"),
            date_to: day ?? date(p, "to"),
            verdict: p.verdict as string | undefined,
            star_min: p.star_min as number | undefined,
            media_type: p.type as string | undefined,
            kind: p.kind as string | undefined,
            q: p.search as string | undefined,
            burst_id: p.burst as number | undefined,
            collapse: p.fold === "pairs" ? "pairs" : "1",
            sort_dir: p.order === "oldest" ? "asc" : undefined,
            limit: (p.limit as number | undefined) ?? 50,
            cursor: p.cursor as string | undefined,
          })}`,
        );
        return { assets: r.assets.map(summarize), next_cursor: r.next_cursor };
      },
    },

    {
      id: "assets.get",
      title: "One medium",
      description:
        "Everything Winnow knows about one medium: file, EXIF, place, pairing, burst, faces count, derivative state and culling — the full row the viewer reads.",
      params: { id: { type: "number", integer: true, min: 1, description: "The asset id" } },
      async run(p) {
        const r = await client.json<{ asset: GridRow }>("GET", `/api/assets/${p.id}`);
        return r.asset;
      },
    },

    {
      id: "assets.look",
      title: "Look at a medium",
      description:
        "The picture itself, to SEE it: the grid thumbnail (about 400 px, cheap) or, with `detail: true`, the culling proxy (about 2048 px, for focus and expression — heavier). A video answers its poster frame. Never the original.",
      params: {
        id: { type: "number", integer: true, min: 1, description: "The asset id" },
        detail: { type: "boolean", optional: true, description: "The 2048 px proxy instead of the thumbnail (photos only)" },
      },
      async run(p): Promise<ImageResult> {
        const { asset } = await client.json<{ asset: GridRow }>("GET", `/api/assets/${p.id}`);
        const detail = p.detail === true;
        if (detail && asset.media_type === "video")
          throw new CommandError("invalid", "a video's proxy is a movie — look at its thumbnail (detail: false)");
        if (asset.derivative_status !== "ready")
          throw new CommandError("unavailable", `no picture yet: its derivatives are ${asset.derivative_status}`);
        const bytes = await client.bytes(`/api/assets/${asset.id}/${detail ? "proxy" : "thumb"}`);
        const size = imageSize(bytes);
        if (!size) throw new CommandError("failed", "the derivative is not a WebP, PNG or JPEG");
        return {
          kind: "image",
          mimeType: size.mimeType,
          data: Buffer.from(bytes).toString("base64"),
          width: size.width,
          height: size.height,
          note: `#${asset.id} ${asset.filename} — ${detail ? "proxy" : "thumbnail"}, ${asset.verdict}${asset.star ? `, ${asset.star}★` : ""}`,
        };
      },
    },

    {
      id: "cull.set",
      title: "Cull",
      description:
        "Set one medium's verdict, stars and/or colour label — the same write as the grid's keys, applied to its RAW+JPEG companion too, and marked as an agent's when the token was minted for one. Fields left out keep their value. Answers the rating as stored.",
      available: canWrite,
      params: {
        id: { type: "number", integer: true, min: 1, description: "The asset id" },
        verdict: { type: "string", enum: VERDICTS, optional: true, description: "pick, reject, skip, or unrated to clear" },
        star: { type: "number", integer: true, min: 0, max: 5, optional: true, description: "0–5 stars (0 clears)" },
        color: { type: "string", enum: COLOR_LABELS, optional: true, description: "A colour label; none clears it" },
      },
      async run(p) {
        if (p.verdict === undefined && p.star === undefined && p.color === undefined)
          throw new CommandError("invalid", "nothing to set — give verdict, star or color");
        const body: Record<string, unknown> = {};
        if (p.verdict !== undefined) body.verdict = p.verdict;
        if (p.star !== undefined) body.star = p.star;
        if (p.color !== undefined) body.color = p.color === "none" ? null : p.color;
        const r = await client.json<{ rating: unknown }>("PATCH", `/api/assets/${p.id}/rating`, body);
        return r.rating;
      },
    },
  ];
}
