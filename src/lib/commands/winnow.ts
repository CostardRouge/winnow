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
// when the token was minted for one (migration 0050, `ratings.rated_via`).
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
type Features = { features: Record<string, boolean> };

const STATUS_TTL_MS = 30_000;

function statusCache(client: WinnowClient) {
  let at = 0;
  let value: Promise<{ me: Me; caps: Capabilities; features: Record<string, boolean> }> | null = null;
  return () => {
    if (!value || Date.now() - at > STATUS_TTL_MS) {
      at = Date.now();
      value = Promise.all([
        client.json<Me>("GET", "/api/auth/me"),
        client.json<Capabilities>("GET", "/api/capabilities"),
        // Which optional sections are on (viewer-visible): the People
        // section gates its own routes (a person's page, rename, merge…).
        client.json<Features>("GET", "/api/features"),
      ]).then(([me, caps, f]) => ({ me, caps, features: f.features ?? {} }));
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

type Folder = {
  id: number;
  name: string;
  captured_at_min: string | null;
  captured_at_max: string | null;
  asset_count: number;
  pick_count: number;
  reject_count: number;
  skip_count: number;
  unrated_count: number;
  status: string;
  ignored: boolean;
  last_reviewed_at: string | null;
  device_hint: string | null;
};

export function summarizeFolder(f: Folder) {
  return {
    id: f.id,
    name: f.name,
    from: f.captured_at_min,
    to: f.captured_at_max,
    media: f.asset_count,
    picks: f.pick_count,
    rejects: f.reject_count,
    skips: f.skip_count,
    unrated: f.unrated_count,
    status: f.status,
    ...(f.device_hint ? { device: f.device_hint } : {}),
    ...(f.last_reviewed_at ? { last_reviewed_at: f.last_reviewed_at } : {}),
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

// One bulk call's ceiling. The routes take any length; an agent's list is
// held to what a person selects in a grid in one go, so a runaway loop
// writes a page, not the library.
export const MAX_BULK = 500;

// Thumbnails one compare call returns: ~12 KB of WebP each, so a dozen is a
// burst's worth without flooding the agent's context.
export const MAX_LOOK = 12;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// People: names an agent types resolved to the ids the filter takes, and the
// face filters a person would click. Pure, tested.

export type PersonRow = {
  id: number;
  name: string | null;
  hidden: boolean;
  asset_count: number;
  incoming_asset_count: number;
  gallery_asset_count: number;
  cover_face_id?: number | null;
};

/**
 * Names → person ids, case- and accent-insensitive on the whole name. A name
 * nobody has, or that two people share, is REFUSED with what would have
 * matched — an agent that filtered on the wrong Vanessa would cull the wrong
 * pictures without ever knowing.
 */
export function resolvePeople(names: readonly string[], people: readonly PersonRow[]): number[] {
  const fold = (x: string) =>
    x
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  const ids: number[] = [];
  for (const raw of names) {
    const want = fold(raw);
    if (!want) throw new CommandError("invalid", `"who" holds an empty name`);
    const exact = people.filter((x) => x.name && fold(x.name) === want);
    if (exact.length === 1) {
      ids.push(exact[0].id);
      continue;
    }
    if (exact.length > 1) {
      throw new CommandError(
        "invalid",
        `"${raw}" names ${exact.length} people: ${exact.map((x) => `#${x.id}`).join(", ")} — pass "people" with the one you mean`,
      );
    }
    const close = people
      .filter((x) => x.name && (fold(x.name).includes(want) || want.includes(fold(x.name))))
      .slice(0, 5)
      .map((x) => `${x.name} (#${x.id})`);
    throw new CommandError(
      "invalid",
      `nobody is named "${raw}"${close.length ? ` — close: ${close.join(", ")}` : " — people.list or people.sheet shows who is named"}`,
    );
  }
  return ids;
}

export const FACE_FILTERS = ["none", "any", "solo", "group"] as const;

/** The filter keys a face filter maps to (`filterFromSearchParams`). */
export function facesFilter(kind: string | undefined): Record<string, string> {
  switch (kind) {
    case "none":
      return { has_faces: "false" };
    case "any":
      return { has_faces: "true" };
    case "solo":
      return { face_count: "1" };
    case "group":
      // face_count takes exact counts; 2–30 covers every real group photo.
      return { face_count: Array.from({ length: 29 }, (_, i) => i + 2).join(",") };
    default:
      return {};
  }
}

const MAX_SHEET = 24;

export function winnowCommands(client: WinnowClient): CommandSpec[] {
  const status = statusCache(client);

  const canWrite = async (): Promise<Availability> => {
    const { me } = await status();
    if (me.user.role === "editor" || me.user.role === "admin") return true;
    return `this token reads only (it runs as ${me.user.role}): an admin mints an editor token on Users › App tokens for an agent that may cull`;
  };

  const peopleOn = async (): Promise<Availability> => {
    const { features } = await status();
    return features.people === false
      ? "the People section is turned off on this instance (Settings › Features)"
      : true;
  };

  const canEditPeople = async (): Promise<Availability> => {
    const on = await peopleOn();
    return on === true ? canWrite() : on;
  };

  // /api/people answers every stack (≈1 MB on the instance): asked once a
  // minute at most, and forgotten after a write that renames, hides or merges.
  let peopleAt = 0;
  let peopleList: Promise<PersonRow[]> | null = null;
  const people = () => {
    if (!peopleList || Date.now() - peopleAt > 60_000) {
      peopleAt = Date.now();
      peopleList = client.json<{ people: PersonRow[] }>("GET", "/api/people").then((r) => r.people);
      peopleList.catch(() => {
        peopleList = null;
      });
    }
    return peopleList;
  };
  const forgetPeople = () => {
    peopleList = null;
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
        "Media in capture order with their culling (verdict, stars, colour, and `by: agent` when an agent set it), newest first unless `order` says otherwise. Filter by a day or a span, a verdict, a minimum star count, a type, a folder, a tag, people (by id or by name, any or together), faces (none, solo, group), a camera, a city or words. One line per RAW+JPEG pair and per burst pile by default (`fold: all`); `fold: pairs` lists every frame of a pile, and `burst` lists one pile's frames. Pages with `cursor` (the `next_cursor` of the previous page).",
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
        folder: { type: "number", integer: true, min: 1, optional: true, description: "One folder's id (library.folders)" },
        tag: { type: "string", optional: true, description: "Only media carrying this tag" },
        people: { type: "numbers", integer: true, min: 1, maxItems: 20, optional: true, description: "Person ids (people.list): media showing any of them, or all of them with together" },
        who: { type: "strings", optional: true, description: "People by NAME, resolved like people: an unknown or shared name is refused with the close ones" },
        together: { type: "boolean", optional: true, description: "With people/who: only media where ALL of them appear (default: any)" },
        faces: { type: "string", enum: FACE_FILTERS, optional: true, description: "none (no face found), any, solo (exactly one face), group (two or more)" },
        camera: { type: "string", optional: true, description: "Camera model, as library.facets names it" },
        city: { type: "string", optional: true, description: "City, as library.facets names it" },
        fold: { type: "string", enum: ["all", "pairs"], optional: true, description: "all (default): a pair or a pile is one line; pairs: every frame of a pile" },
        order: { type: "string", enum: ["newest", "oldest"], optional: true, description: "newest (default) or oldest first" },
        limit: { type: "number", integer: true, min: 1, max: 200, optional: true, description: "Page size, 50 by default" },
        cursor: { type: "string", optional: true, description: "next_cursor from the previous page" },
        trash: { type: "boolean", optional: true, description: "List the trash instead of the live library" },
      },
      async run(p) {
        const day = date(p, "day");
        if (day && (p.from !== undefined || p.to !== undefined))
          throw new CommandError("invalid", `"day" or "from"/"to", not both`);
        const who = (p.who as string[] | undefined) ?? [];
        const personIds = [
          ...new Set([
            ...((p.people as number[] | undefined) ?? []),
            ...(who.length ? resolvePeople(who, await people()) : []),
          ]),
        ];
        if (p.together === true && personIds.length < 2)
          throw new CommandError("invalid", `"together" needs two people or more`);
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
            session_id: p.folder as number | undefined,
            tags: p.tag as string | undefined,
            person: personIds.length ? personIds.join(",") : undefined,
            person_mode: personIds.length > 1 ? (p.together === true ? "all" : "any") : undefined,
            ...facesFilter(p.faces as string | undefined),
            camera_model: p.camera as string | undefined,
            place_city: p.city as string | undefined,
            collapse: p.fold === "pairs" ? "pairs" : "1",
            sort_dir: p.order === "oldest" ? "asc" : undefined,
            limit: (p.limit as number | undefined) ?? 50,
            cursor: p.cursor as string | undefined,
            deleted: p.trash === true ? "trash" : undefined,
          })}`,
        );
        return { assets: r.assets.map(summarize), next_cursor: r.next_cursor };
      },
    },

    {
      id: "library.folders",
      title: "Folders",
      description:
        "The library's folders (shooting sessions) with their triage progress — picks, rejects, skips, unrated, and `status` (to_sort / done / empty) — what the Sift page ranks. `progress: incomplete` lists what is still to sort. Answers `total` and the first `limit` folders, so a partial answer says so.",
      params: {
        kind: { type: "string", enum: ["incoming", "final"], optional: true, description: "incoming (default) = the cull's material, final = the delivered gallery" },
        progress: { type: "string", enum: ["untouched", "partial", "incomplete", "complete"], optional: true, description: "Only folders at this stage of the cull" },
        sort: { type: "string", enum: ["captured", "touched", "progress", "count"], optional: true, description: "captured (default), touched (latest verdict), progress, count (media)" },
        order: { type: "string", enum: ["desc", "asc"], optional: true, description: "desc (default) or asc" },
        limit: { type: "number", integer: true, min: 1, max: 200, optional: true, description: "How many folders, 30 by default" },
      },
      async run(p) {
        const r = await client.json<{ sessions: Folder[] }>(
          "GET",
          `/api/sessions${query({
            kind: (p.kind as string | undefined) ?? "incoming",
            progress: p.progress as string | undefined,
            sort: p.sort as string | undefined,
            sort_dir: p.order as string | undefined,
          })}`,
        );
        const limit = (p.limit as number | undefined) ?? 30;
        return {
          total: r.sessions.length,
          shown: Math.min(limit, r.sessions.length),
          folders: r.sessions.slice(0, limit).map(summarizeFolder),
        };
      },
    },

    {
      id: "library.facets",
      title: "Facets",
      description:
        "The values the library's filters can take, with counts: years, months, cameras, lenses, devices, countries/regions/cities/places, people, tags, extensions, burst totals — what to put in assets.list's camera / city / person / tag.",
      params: {
        kind: { type: "string", enum: ["incoming", "final"], optional: true, description: "One half of the library; both when absent" },
      },
      async run(p) {
        return client.json("GET", `/api/facets${query({ kind: p.kind as string | undefined })}`);
      },
    },

    {
      id: "people.list",
      title: "People",
      description:
        "The people the face analysis has grouped — named ones first, then busiest — with how many media show them. Their ids (or names, as `who`) filter assets.list; people.sheet shows their faces. Answers `total` and the first `limit` from `offset`.",
      params: {
        named: { type: "boolean", optional: true, description: "Only people who have a name" },
        unnamed: { type: "boolean", optional: true, description: "Only people with no name yet — the ones to name" },
        hidden: { type: "boolean", optional: true, description: "List the hidden stacks instead" },
        offset: { type: "number", integer: true, min: 0, optional: true, description: "Skip this many (paging)" },
        limit: { type: "number", integer: true, min: 1, max: 500, optional: true, description: "How many, 50 by default" },
      },
      async run(p) {
        if (p.named === true && p.unnamed === true)
          throw new CommandError("invalid", `"named" or "unnamed", not both`);
        const all = (await people()).filter(
          (x) =>
            x.hidden === (p.hidden === true) &&
            (p.named !== true || !!x.name) &&
            (p.unnamed !== true || !x.name),
        );
        const offset = (p.offset as number | undefined) ?? 0;
        const limit = (p.limit as number | undefined) ?? 50;
        const page = all.slice(offset, offset + limit);
        return {
          total: all.length,
          shown: page.length,
          offset,
          people: page.map((x) => ({
            id: x.id,
            name: x.name,
            media: x.asset_count,
            incoming: x.incoming_asset_count,
            gallery: x.gallery_asset_count,
          })),
        };
      },
    },

    {
      id: "people.get",
      title: "One person",
      description:
        "One person: name, hidden, how many faces and media in each half of the library, the cover face, and their faces (face id, asset id, detection score, best first — 200 at most).",
      available: peopleOn,
      params: {
        id: { type: "number", integer: true, min: 1, description: "The person id" },
        faces: { type: "number", integer: true, min: 0, max: 200, optional: true, description: "How many faces to list, 50 by default" },
      },
      async run(p) {
        const r = await client.json<{
          person: PersonRow & { face_count: number; incoming_face_count: number; gallery_face_count: number };
          faces: { id: number; asset_id: number; score: number }[];
        }>("GET", `/api/people/${p.id}`);
        const n = (p.faces as number | undefined) ?? 50;
        return {
          person: r.person,
          facesTotal: r.faces.length,
          faces: r.faces.slice(0, n).map((f) => ({ face: f.id, asset: f.asset_id, score: Math.round(f.score * 1000) / 1000 })),
        };
      },
    },

    {
      id: "people.sheet",
      title: "Who is who",
      description: `The cover face of several people, one picture each labelled "#id name" — to SEE who a stack is before naming, merging or filtering on it. Pick them by ids, or page through named / unnamed people (${MAX_SHEET} at most a call). A person with no usable face is named and skipped.`,
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_SHEET, optional: true, description: "Person ids (else the list's order)" },
        unnamed: { type: "boolean", optional: true, description: "Only people with no name yet" },
        named: { type: "boolean", optional: true, description: "Only named people" },
        offset: { type: "number", integer: true, min: 0, optional: true, description: "Skip this many (paging)" },
        limit: { type: "number", integer: true, min: 1, max: MAX_SHEET, optional: true, description: `How many, 12 by default (${MAX_SHEET} at most)` },
      },
      async run(p): Promise<unknown[]> {
        if (p.named === true && p.unnamed === true)
          throw new CommandError("invalid", `"named" or "unnamed", not both`);
        const all = await people();
        let chosen: PersonRow[];
        if (p.ids) {
          const byId = new Map(all.map((x) => [x.id, x]));
          const ids = p.ids as number[];
          const missing = ids.filter((id) => !byId.has(id));
          if (missing.length) throw new CommandError("invalid", `no such person: ${missing.join(", ")}`);
          chosen = ids.map((id) => byId.get(id)!);
        } else {
          const offset = (p.offset as number | undefined) ?? 0;
          const limit = (p.limit as number | undefined) ?? 12;
          chosen = all
            .filter((x) => !x.hidden && (p.named !== true || !!x.name) && (p.unnamed !== true || !x.name))
            .slice(offset, offset + limit);
        }
        return Promise.all(
          chosen.map(async (x): Promise<unknown> => {
            const label = `#${x.id} ${x.name ?? "(unnamed)"} — ${x.asset_count} media`;
            if (!x.cover_face_id) return { skipped: x.id, why: `${label}: no face to show` };
            try {
              const bytes = await client.bytes(`/api/faces/${x.cover_face_id}/thumb`);
              const size = imageSize(bytes);
              if (!size) return { skipped: x.id, why: `${label}: unreadable face crop` };
              const img: ImageResult = {
                kind: "image",
                mimeType: size.mimeType,
                data: Buffer.from(bytes).toString("base64"),
                width: size.width,
                height: size.height,
                note: label,
              };
              return img;
            } catch (err) {
              return { skipped: x.id, why: `${label}: ${err instanceof Error ? err.message : String(err)}` };
            }
          }),
        );
      },
    },

    {
      id: "people.suggestions",
      title: "Probably the same person",
      description:
        "Pairs of stacks the face model thinks are one person (most alike first), with their names and counts — what to check with people.sheet and then people.merge. Nothing is merged by asking.",
      available: peopleOn,
      params: {
        limit: { type: "number", integer: true, min: 1, max: 100, optional: true, description: "How many pairs, 20 by default" },
      },
      async run(p) {
        const [r, all] = await Promise.all([
          client.json<{ suggestions: { a: number; b: number; similarity: number }[]; more: boolean }>("GET", "/api/people/suggestions"),
          people(),
        ]);
        const byId = new Map(all.map((x) => [x.id, x]));
        const who = (id: number) => {
          const x = byId.get(id);
          return { id, name: x?.name ?? null, media: x?.asset_count ?? null };
        };
        const limit = (p.limit as number | undefined) ?? 20;
        return {
          more: r.more || r.suggestions.length > limit,
          pairs: r.suggestions.slice(0, limit).map((s) => ({
            a: who(s.a),
            b: who(s.b),
            similarity: Math.round(s.similarity * 1000) / 1000,
          })),
        };
      },
    },

    {
      id: "assets.faces",
      title: "Who is in it",
      description:
        "The faces found in one medium: face id, person id and name (null when the face matched nobody yet), detection score, and the box in the analysed image's pixels with that image's size.",
      params: { id: { type: "number", integer: true, min: 1, description: "The asset id" } },
      async run(p) {
        const r = await client.json<{
          faces: {
            id: number;
            person_id: number | null;
            person_name: string | null;
            score: number;
            x1: number;
            y1: number;
            x2: number;
            y2: number;
            img_width: number;
            img_height: number;
          }[];
        }>("GET", `/api/assets/${p.id}/faces`);
        return {
          faces: r.faces.map((f) => ({
            face: f.id,
            person: f.person_id,
            name: f.person_name,
            score: Math.round(f.score * 1000) / 1000,
            box: [f.x1, f.y1, f.x2, f.y2],
            image: [f.img_width, f.img_height],
          })),
        };
      },
    },

    {
      id: "people.name",
      title: "Name a person",
      description:
        "Give a person a name, or clear it with an empty string (PATCH /api/people/:id, the People page's rename). Look at them first (people.sheet).",
      available: canEditPeople,
      params: {
        id: { type: "number", integer: true, min: 1, description: "The person id" },
        name: { type: "string", description: "The name, 120 characters at most; \"\" clears it" },
      },
      async run(p) {
        const name = (p.name as string).trim();
        if (name.length > 120) throw new CommandError("invalid", `"name" is ${name.length} characters — 120 at most`);
        await client.json("PATCH", `/api/people/${p.id}`, { name: name || null });
        forgetPeople();
        return { id: p.id, name: name || null };
      },
    },

    {
      id: "people.hide",
      title: "Hide a person",
      description:
        "Hide a stack from every default list and picker (strangers, posters, statues), or show it again. Reversible; nothing is deleted.",
      available: canEditPeople,
      params: {
        id: { type: "number", integer: true, min: 1, description: "The person id" },
        hidden: { type: "boolean", description: "true hides, false shows again" },
      },
      async run(p) {
        await client.json("PATCH", `/api/people/${p.id}`, { hidden: p.hidden });
        forgetPeople();
        return { id: p.id, hidden: p.hidden };
      },
    },

    {
      id: "people.merge",
      title: "Merge two people",
      description:
        "Fold one stack into another that is the same person (POST /api/people/:into/merge): `into` keeps its name and cover and takes every face; `from` disappears. Hard to undo — only people.reassign moves faces back, photo by photo — so look at both with people.sheet first.",
      available: canEditPeople,
      params: {
        from: { type: "number", integer: true, min: 1, description: "The person to fold in (it disappears)" },
        into: { type: "number", integer: true, min: 1, description: "The person who stays" },
      },
      async run(p) {
        if (p.from === p.into) throw new CommandError("invalid", `"from" and "into" are the same person`);
        await client.json("POST", `/api/people/${p.into}/merge`, { source_id: p.from });
        forgetPeople();
        return { merged: p.from, into: p.into };
      },
    },

    {
      id: "people.reassign",
      title: "Move faces to another person",
      description:
        "Move this person's faces in some photos to another person — or, without `to`, into a new unnamed stack (POST /api/people/:id/reassign, the person page's fix for a wrong match). Only THIS person's face in each photo moves; others in frame stay.",
      available: canEditPeople,
      params: {
        person: { type: "number", integer: true, min: 1, description: "The person whose faces move" },
        assets: { type: "numbers", integer: true, min: 1, maxItems: MAX_BULK, description: `The photos (asset ids, ${MAX_BULK} at most a call)` },
        to: { type: "number", integer: true, min: 1, optional: true, description: "The person they move to; absent = a new unnamed stack" },
      },
      async run(p) {
        if (p.to === p.person) throw new CommandError("invalid", `"to" is the same person`);
        const r = await client.json("POST", `/api/people/${p.person}/reassign`, {
          asset_ids: p.assets,
          ...(p.to !== undefined ? { target_person_id: p.to } : {}),
        });
        forgetPeople();
        return r;
      },
    },

    {
      id: "assets.search",
      title: "Search by meaning",
      description:
        "Media ranked by how well they match a description in plain words — 'sunset on the beach', 'people around a table', 'a bird close-up' (CLIP, GET /api/search). Closest first, with `distance` (lower is closer). Answers `enabled: false` with the reason when the instance's semantic index is off or empty; assets.list's `search` matches names and places instead.",
      params: {
        text: { type: "string", description: "What to look for, up to 300 characters" },
        source: { type: "string", enum: ["incoming", "gallery"], optional: true, description: "One half of the library; both when absent" },
        limit: { type: "number", integer: true, min: 1, max: 200, optional: true, description: "How many, 30 by default" },
      },
      async run(p) {
        const text = (p.text as string).trim();
        if (!text || text.length > 300)
          throw new CommandError("invalid", `"text" must be 1–300 characters`);
        const r = await client.json<{ items: (GridRow & { distance: number })[]; enabled?: boolean; reason?: string; indexed?: number }>(
          "GET",
          `/api/search${query({ q: text, source: p.source as string | undefined, limit: (p.limit as number | undefined) ?? 30 })}`,
        );
        if (r.enabled === false || r.indexed === 0)
          return {
            enabled: false,
            reason: r.reason ?? (r.indexed === 0 ? "no media is indexed for search yet" : "semantic search is off on this instance"),
            assets: [],
          };
        return {
          enabled: true,
          assets: r.items.map((a) => ({ ...summarize(a), distance: Math.round(a.distance * 1000) / 1000 })),
        };
      },
    },

    {
      id: "assets.similar",
      title: "Near-duplicates",
      description:
        "The media that LOOK like one medium — re-exports, burst neighbours, a slightly different crop — by perceptual-hash distance (0 = identical, ~10 = very close, >16 = probably unrelated). The 'which of these do I keep' question (GET /api/assets/:id/similar).",
      params: {
        id: { type: "number", integer: true, min: 1, description: "The asset id" },
        maxDistance: { type: "number", integer: true, min: 0, max: 64, optional: true, description: "Farthest distance kept (the instance's default when absent)" },
        limit: { type: "number", integer: true, min: 1, max: 200, optional: true, description: "How many (the instance's default when absent)" },
      },
      async run(p) {
        return client.json(
          "GET",
          `/api/assets/${p.id}/similar${query({ max_distance: p.maxDistance as number | undefined, limit: p.limit as number | undefined })}`,
        );
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
      id: "assets.lookMany",
      title: "Compare",
      description:
        "Several thumbnails at once (about 400 px each), one image per medium in the order asked — a burst's frames or a few candidates side by side, to choose the keeper. At most 12 a call; a medium with no picture yet is named and skipped.",
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_LOOK, description: `Asset ids (at most ${MAX_LOOK})` },
      },
      async run(p): Promise<ImageResult[]> {
        const ids = p.ids as number[];
        const out = await Promise.all(
          ids.map(async (id): Promise<ImageResult> => {
            const { asset } = await client.json<{ asset: GridRow }>("GET", `/api/assets/${id}`);
            if (asset.derivative_status !== "ready")
              throw new CommandError("unavailable", `#${id}: no picture yet (derivatives ${asset.derivative_status})`);
            const bytes = await client.bytes(`/api/assets/${id}/thumb`);
            const size = imageSize(bytes);
            if (!size) throw new CommandError("failed", `#${id}: the thumbnail is not a WebP, PNG or JPEG`);
            return {
              kind: "image",
              mimeType: size.mimeType,
              data: Buffer.from(bytes).toString("base64"),
              width: size.width,
              height: size.height,
              note: `#${asset.id} ${asset.filename} — ${asset.verdict}${asset.star ? `, ${asset.star}★` : ""}`,
            };
          }).map((pr, i) =>
            pr.catch((err: unknown) => {
              // One missing derivative must not hide the eleven others.
              const why = err instanceof Error ? err.message : String(err);
              return { skipped: ids[i], why } as unknown as ImageResult;
            }),
          ),
        );
        return out;
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

    {
      id: "trash.move",
      title: "Trash",
      description:
        "Send REJECTED media to the trash (POST /api/assets/delete): a soft delete — hidden from every listing and export, the original untouched, undone by trash.restore. Only media whose verdict is already reject are accepted, so what an agent trashes is first a reject it made visibly (and marked); any other id refuses the whole call, naming it. Freeing the space (purge) is an admin's confirmed step, out of a token's reach.",
      available: canWrite,
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_BULK, description: `Rejected asset ids (at most ${MAX_BULK} a call)` },
      },
      async run(p) {
        const ids = [...new Set(p.ids as number[])];
        const r = await client.json<{ assets: { id: number }[] }>(
          "GET",
          `/api/assets${query({ ids: ids.join(","), verdict: "reject", limit: MAX_BULK })}`,
        );
        const rejected = new Set(r.assets.map((a) => a.id));
        const refused = ids.filter((id) => !rejected.has(id));
        if (refused.length)
          throw new CommandError(
            "invalid",
            `not rejected (or not in the live library): ${refused.join(", ")} — reject them first (cull.set / cull.setMany), nothing was trashed`,
          );
        return client.json("POST", "/api/assets/delete", { ids });
      },
    },

    {
      id: "trash.restore",
      title: "Restore",
      description:
        "Bring trashed media back to the library (POST /api/assets/delete with restore) — each pair's companion too. A purged medium cannot come back: its file is gone.",
      available: canWrite,
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_BULK, description: `Asset ids (at most ${MAX_BULK} a call)` },
      },
      async run(p) {
        return client.json("POST", "/api/assets/delete", { ids: p.ids, restore: true });
      },
    },

    {
      id: "tags.list",
      title: "Tags",
      description: "Every tag with how many media carry it (GET /api/tags).",
      async run() {
        return client.json("GET", "/api/tags");
      },
    },

    {
      id: "tags.assign",
      title: "Tag",
      description:
        "Add and/or remove tags by NAME on several media (POST /api/tags/assign, the grid's tag gesture); a tag that does not exist yet is created. Tags are labels for finding media again — keepers for a series, a client, an edit to do — and change no verdict. Winnow records no author on a tag link, so an agent's tags are not marked as its own.",
      available: canWrite,
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_BULK, description: `Asset ids (at most ${MAX_BULK} a call)` },
        add: { type: "strings", optional: true, description: "Tag names to add (1–64 characters each)" },
        remove: { type: "strings", optional: true, description: "Tag names to remove" },
      },
      async run(p) {
        const add = (p.add as string[] | undefined)?.map((t) => t.trim()) ?? [];
        const remove = (p.remove as string[] | undefined)?.map((t) => t.trim()) ?? [];
        if (!add.length && !remove.length)
          throw new CommandError("invalid", "nothing to do — give add or remove");
        for (const t of [...add, ...remove])
          if (t.length < 1 || t.length > 64)
            throw new CommandError("invalid", `tag "${t}" — a name is 1–64 characters`);
        return client.json("POST", "/api/tags/assign", {
          ids: p.ids,
          ...(add.length ? { add } : {}),
          ...(remove.length ? { remove } : {}),
        });
      },
    },

    {
      id: "cull.setMany",
      title: "Cull many",
      description:
        "Set the verdict and/or stars of several media in one write — the grid's bulk gesture (POST /api/ratings/bulk), each pair's companion included. With `wholePile: true` every frame of each id's burst pile is rated too: the 'cull the pile' gesture, e.g. reject a whole burst once its keeper is picked (then pick the keeper again with cull.set). Colour labels are one at a time (cull.set). Marked as an agent's when the token was minted for one.",
      available: canWrite,
      params: {
        ids: { type: "numbers", integer: true, min: 1, maxItems: MAX_BULK, description: `Asset ids (at most ${MAX_BULK} a call)` },
        verdict: { type: "string", enum: VERDICTS, optional: true, description: "pick, reject, skip, or unrated to clear" },
        star: { type: "number", integer: true, min: 0, max: 5, optional: true, description: "0–5 stars (0 clears)" },
        wholePile: { type: "boolean", optional: true, description: "Also every frame of each id's burst pile" },
      },
      async run(p) {
        if (p.verdict === undefined && p.star === undefined)
          throw new CommandError("invalid", "nothing to set — give verdict or star");
        const body: Record<string, unknown> = { ids: p.ids };
        if (p.verdict !== undefined) body.verdict = p.verdict;
        if (p.star !== undefined) body.star = p.star;
        if (p.wholePile === true) body.expand_bursts = true;
        return client.json("POST", "/api/ratings/bulk", body);
      },
    },
  ];
}
