import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createCommandRegistry, type CommandError } from "./registry";
import { HttpError, httpClient, winnowCommands, type WinnowClient } from "./winnow";
import { imageSize } from "./imageSize";

type Call = { method: string; path: string; body?: unknown };

function fakeClient(opts: { role?: string; via?: string; timeline?: boolean; bytes?: Uint8Array; asset?: object } = {}) {
  const calls: Call[] = [];
  const client: WinnowClient = {
    base: "https://winnow.test",
    async json(method, path, body) {
      calls.push({ method, path, body });
      if (path === "/api/auth/me")
        return { user: { id: 1, username: "steeve", displayName: null, role: opts.role ?? "editor", via: opts.via ?? "agent" } } as never;
      if (path === "/api/capabilities") return { api: { version: 1 }, media: { timeline: opts.timeline ?? false } } as never;
      if (path.startsWith("/api/assets?")) return { assets: [ROW], next_cursor: "abc" } as never;
      if (/^\/api\/assets\/\d+$/.test(path)) return { asset: opts.asset ?? ROW } as never;
      if (path.endsWith("/rating")) return { rating: { asset_id: 7, ...(body as object) } } as never;
      return {} as never;
    },
    async bytes(path) {
      calls.push({ method: "GET", path });
      return opts.bytes ?? new Uint8Array();
    },
  };
  const reg = createCommandRegistry();
  reg.register("winnow", winnowCommands(client));
  return { reg, calls };
}

const ROW = {
  id: 7,
  filename: "DSC01234.ARW",
  ext: "arw",
  media_type: "photo",
  rel_path: "2025/01/DSC01234.ARW",
  session_id: 3,
  captured_at: "2025-01-04T10:00:00Z",
  capture_date: "2025-01-04T00:00:00.000Z",
  width: 7008,
  height: 4672,
  duration_s: null,
  device: "Sony ILCE-7CM2",
  camera_model: "ILCE-7CM2",
  lens: "FE 35mm F1.8",
  iso: 100,
  aperture: 2.8,
  shutter: "1/250",
  focal_length: 35,
  place_city: "Sydney",
  place_country: "Australia",
  place_poi: null,
  gps_lat: -33.8,
  gps_lon: 151.2,
  derivative_status: "ready",
  verdict: "pick",
  star: 3,
  color_label: null,
  rated_via: "agent",
  tags: [],
  companion_id: 8,
  group_kind: "raw_jpeg",
  burst_id: null,
  burst_count: null,
  burst_kind: null,
  face_count: 0,
  sharpness: null,
};

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CommandError) => `${e.code}: ${e.message}`,
  );

test("a viewer token is told why it cannot cull, before it tries", async () => {
  const { reg, calls } = fakeClient({ role: "viewer" });
  const cull = (await reg.list()).find((c) => c.id === "cull.set")!;
  assert.equal(cull.available, false);
  assert.match(cull.reason!, /reads only .* editor token/);
  assert.match((await failure(reg.execute("cull.set", { id: 7, verdict: "pick" })))!, /^unavailable/);
  assert.ok(!calls.some((c) => c.method === "PATCH"), "nothing was sent");
});

test("cull.set sends the grid's own PATCH, colour 'none' clearing the label", async () => {
  const { reg, calls } = fakeClient();
  await reg.execute("cull.set", { id: 7, verdict: "reject", star: 0, color: "none" });
  assert.deepEqual(calls.at(-1), {
    method: "PATCH",
    path: "/api/assets/7/rating",
    body: { verdict: "reject", star: 0, color: null },
  });
  assert.match((await failure(reg.execute("cull.set", { id: 7 })))!, /^invalid: nothing to set/);
  assert.match((await failure(reg.execute("cull.set", { id: 7, star: 6 })))!, /above its maximum 5/);
});

test("assets.list maps a day onto the filter and folds by default", async () => {
  const { reg, calls } = fakeClient();
  const r = (await reg.execute("assets.list", { day: "2025-01-04", verdict: "pick" })) as {
    assets: { culling: object; exposure: string; pair: object }[];
    next_cursor: string;
  };
  const url = new URL(`https://x${calls.at(-1)!.path}`);
  assert.equal(url.pathname, "/api/assets");
  assert.equal(url.searchParams.get("date_from"), "2025-01-04");
  assert.equal(url.searchParams.get("date_to"), "2025-01-04");
  assert.equal(url.searchParams.get("collapse"), "1");
  assert.equal(url.searchParams.get("verdict"), "pick");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.deepEqual(r.assets[0].culling, { verdict: "pick", star: 3, color: null, by: "agent" });
  assert.equal(r.assets[0].exposure, "35mm f/2.8 1/250s ISO 100");
  assert.equal((r.assets[0] as unknown as { day: string }).day, "2025-01-04");
  assert.deepEqual(r.assets[0].pair, { kind: "raw_jpeg", companion_id: 8 });
  assert.equal(r.next_cursor, "abc");
  assert.match((await failure(reg.execute("assets.list", { day: "2025-1-4" })))!, /YYYY-MM-DD/);
  assert.match((await failure(reg.execute("assets.list", { day: "2025-01-04", from: "2025-01-01" })))!, /not both/);
});

test("library.days refuses a reversed or over-long span", async () => {
  const { reg } = fakeClient();
  assert.match((await failure(reg.execute("library.days", { from: "2025-02-01", to: "2025-01-01" })))!, /before/);
  assert.match((await failure(reg.execute("library.days", { from: "2020-01-01", to: "2025-01-01" })))!, /366 at most/);
  await reg.execute("library.days", { from: "2025-01-01", to: "2025-12-31", kind: "incoming" });
});

test("library.chapters is unavailable while the Timeline is off, with the reason", async () => {
  const off = fakeClient({ timeline: false });
  const c = (await off.reg.list()).find((x) => x.id === "library.chapters")!;
  assert.equal(c.available, false);
  assert.match(c.reason!, /Timeline is turned off/);
});

test("app.status says who the agent is and whether it may write", async () => {
  const { reg } = fakeClient({ role: "viewer", via: "agent", timeline: true });
  assert.deepEqual(await reg.execute("app.status"), {
    instance: "https://winnow.test",
    api: 1,
    actsAs: "steeve",
    role: "viewer",
    via: "agent",
    writes: false,
    markedAsAgent: true,
    timeline: true,
  });
});

test("assets.look answers the thumbnail as a picture, sized from its header", async () => {
  const webp = new Uint8Array(
    await sharp({ create: { width: 400, height: 267, channels: 3, background: "#888" } }).webp().toBuffer(),
  );
  const { reg, calls } = fakeClient({ bytes: webp });
  const img = (await reg.execute("assets.look", { id: 7 })) as Record<string, unknown>;
  assert.equal(calls.at(-1)!.path, "/api/assets/7/thumb");
  assert.equal(img.kind, "image");
  assert.equal(img.mimeType, "image/webp");
  assert.equal(img.width, 400);
  assert.equal(img.height, 267);
  assert.equal(Buffer.from(img.data as string, "base64").length, webp.length);

  const video = fakeClient({ bytes: webp, asset: { ...ROW, media_type: "video" } });
  assert.match((await failure(video.reg.execute("assets.look", { id: 7, detail: true })))!, /^invalid: a video's proxy is a movie/);
  const pending = fakeClient({ asset: { ...ROW, derivative_status: "pending" } });
  assert.match((await failure(pending.reg.execute("assets.look", { id: 7 })))!, /^unavailable: no picture yet/);
});

test("imageSize reads WebP (lossy, lossless, extended), PNG and JPEG headers", async () => {
  const base = () => sharp({ create: { width: 123, height: 45, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } });
  const cases: [string, Buffer][] = [
    ["image/webp", await base().webp().toBuffer()],
    ["image/webp", await base().webp({ lossless: true }).toBuffer()],
    ["image/webp", await base().withMetadata().webp().toBuffer()],
    ["image/png", await base().png().toBuffer()],
    ["image/jpeg", await base().jpeg().toBuffer()],
  ];
  for (const [mime, buf] of cases) {
    assert.deepEqual(imageSize(new Uint8Array(buf)), { mimeType: mime, width: 123, height: 45 });
  }
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});

test("httpClient sends the Bearer token and surfaces the server's error text", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ error: "requires the editor role (you are viewer)" }), { status: 403 });
  }) as unknown as typeof fetch;
  const c = httpClient("https://w.test/", "wnw_secret", fakeFetch);
  await assert.rejects(c.json("PATCH", "/api/assets/1/rating", { star: 1 }), (e: HttpError) => {
    assert.equal(e.status, 403);
    assert.match(e.message, /HTTP 403 requires the editor role/);
    return true;
  });
  assert.equal(seen[0].url, "https://w.test/api/assets/1/rating");
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, "Bearer wnw_secret");
});

test("cull.setMany sends the bulk gesture, the pile only when asked", async () => {
  const { reg, calls } = fakeClient();
  await reg.execute("cull.setMany", { ids: [7, 9], verdict: "reject", wholePile: true });
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/api/ratings/bulk",
    body: { ids: [7, 9], verdict: "reject", expand_bursts: true },
  });
  await reg.execute("cull.setMany", { ids: [7], star: 2 });
  assert.deepEqual(calls.at(-1)!.body, { ids: [7], star: 2 });
  assert.match((await failure(reg.execute("cull.setMany", { ids: [7] })))!, /^invalid: nothing to set/);
  const many = Array.from({ length: 501 }, (_, i) => i + 1);
  assert.match((await failure(reg.execute("cull.setMany", { ids: many, verdict: "pick" })))!, /500 at most/);
});

test("tags.assign sends trimmed names and refuses an empty gesture", async () => {
  const { reg, calls } = fakeClient();
  await reg.execute("tags.assign", { ids: [7], add: [" keeper "], remove: ["todo"] });
  assert.deepEqual(calls.at(-1), {
    method: "POST",
    path: "/api/tags/assign",
    body: { ids: [7], add: ["keeper"], remove: ["todo"] },
  });
  assert.match((await failure(reg.execute("tags.assign", { ids: [7] })))!, /^invalid: nothing to do/);
  assert.match((await failure(reg.execute("tags.assign", { ids: [7], add: ["  "] })))!, /1–64 characters/);
  const ro = fakeClient({ role: "viewer" });
  assert.match((await failure(ro.reg.execute("tags.assign", { ids: [7], add: ["x"] })))!, /^unavailable/);
});
