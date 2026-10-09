// GET /api/capabilities → what THIS instance can do, for a client app.
//
// Atelier (the editing half of the stack) reads this once when a user connects
// an instance, and again on explicit refresh — never at boot. It is the
// contract, not the documentation: a client decides from these flags whether
// to offer a feature or to say plainly why it cannot ("this instance does not
// serve Range on originals"), instead of guessing from a version number.
// Every flag here states a FACT about the code as it is; do not flip one to
// true ahead of the feature, and do not remove one a client may already read —
// add, deprecate, never rename.
//
// Viewer-visible on purpose (every GET is): the answer contains nothing a
// signed-in user cannot already learn by using the app, and the `viewer` block
// is how the client knows whether write-back is even possible for THIS account.
import type { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { TOKEN_PREFIX, authViaFromHeaders, identityFromHeaders } from "@/lib/auth";
import { QUERY_TOKEN_ROUTES, TOKEN_QUERY_PARAM } from "@/lib/authz";
import { json, serverError } from "@/lib/api";
import { DOC_KINDS, MAX_DOC_BYTES } from "@/lib/appDocuments";
import { MAX_FILE_BYTES, MAX_USER_BYTES } from "@/lib/appFiles";
import { getFeatures } from "@/lib/featureGate";

export const dynamic = "force-dynamic";

// Bump when a field's MEANING changes; adding a field is not a bump.
const API_VERSION = 1;

export async function GET(req: NextRequest) {
  try {
    const me = identityFromHeaders(req.headers);
    const features = await getFeatures();
    return json({
      api: { version: API_VERSION },
      auth: {
        // The session cookie, which a same-site client app gets for free
        // through CORS (lib/cors.ts), and an app token (migration 0045) for a
        // client that cannot hold the cookie — a home-screen web app in its
        // own cookie jar. `oauth2` would be added here when built.
        methods: ["cookie", "token"],
        corsEnabled: config.cors.allowedOrigins.length > 0,
        // How a token travels. The header works on every API route; the query
        // parameter only on the media an element loads by URL (lib/authz.ts,
        // QUERY_TOKEN_ROUTES), because an <img> or a <video> cannot send a
        // header — anywhere else it is ignored.
        token: {
          header: "Authorization: Bearer",
          prefix: TOKEN_PREFIX,
          queryParam: TOKEN_QUERY_PARAM,
          queryRoutes: [...QUERY_TOKEN_ROUTES],
          // Minted by an admin on Users › App tokens; a token never reaches a
          // page, nor /api/auth/* beyond GET /api/auth/me.
          roles: ["viewer", "editor"],
          // A token may be minted FOR AN AGENT (migration 0048): same caps,
          // reported as `viewer.via: "agent"`, and what it writes is stamped
          // as an agent's (`ratings.rated_via`).
          agent: true,
        },
      },
      media: {
        // asset_sidecars: Sony XML/THM and the DJI .SRT flight log, served by
        // /api/sidecars/:id/download and inlined in every /api/assets row.
        sidecars: true,
        // lib/serve.ts answers 206 for thumb/proxy; the original download
        // route streams whole — a seeking player must use the proxy.
        rangeOnDerivatives: true,
        rangeOnOriginals: false,
        proxies: {
          video: {
            container: "mp4",
            codec: "h264",
            audio: "aac",
            faststart: true,
            height: config.video.proxyHeight,
          },
          photo: { format: "webp", size: config.proxySize },
        },
        // Every list row carries `content_hash` (partial: size + head + tail
        // 64 KiB windows, cf. lib/hash.ts) — the identity a client can
        // recompute locally from a file.
        contentHash: "partial-sha256",
        // The values GET /api/assets takes for `collapse`: `1` folds a
        // RAW+JPEG pair to its primary and a burst pile to its cover,
        // `pairs` folds the pairs only and lists every frame of a pile — so a
        // client reading verdicts can see a frame picked inside a pile.
        // Atelier asks `pairs` only when it is listed here.
        listCollapse: ["1", "pairs"],
        // Whether GET /api/assets/timeline answers on this instance. Winnow's
        // timeline is behind a feature flag (Settings › Features, default OFF
        // while its chapter derivation is reworked) and the route 404s when it
        // is off, so a client must be told rather than left to guess from a
        // 404 that could equally mean "old Winnow".
        //
        // Atelier already reads exactly this key
        // (`shared/sources/winnow/client.ts`, `hasTimeline`) and treats only an
        // explicit `false` as "no timeline" — which is why this is stated here
        // and not in a `features` block of its own.
        timeline: features.timeline,
      },
      // Where a client app keeps its own documents (api/apps/[app]/docs,
      // migration 0041): own rows for any signed-in role, an etag that
      // refuses a stale write, a body cap the client checks before sending.
      documents: { bucket: true, kinds: [...DOC_KINDS], maxBytes: MAX_DOC_BYTES },
      // The binary half of the same idea (api/apps/[app]/files, migration
      // 0044): blobs a client keeps here, content-addressed by SHA-256, own
      // rows for any signed-in role. A client that must hold something bigger
      // than a document — Atelier's purchased LUT lattices, 1.5-2 MB apiece —
      // asks here before offering to keep it.
      files: { bucket: true, maxBytes: MAX_FILE_BYTES, quotaBytes: MAX_USER_BYTES },
      // Server-side reminders / proactive work. Not built, and a browser tab
      // cannot do it alone — so a client shows nothing rather than a button.
      scheduling: { reminders: false },
      limits: {
        // Unknown here: the cap is whatever the reverse proxy / tunnel in
        // front enforces, which this process cannot see. Null means "not
        // declared", never "unlimited".
        maxUploadBytes: null,
      },
      storage: {
        driver: config.storage.driver,
        // On S3 the file routes answer with a signed redirect rather than
        // bytes — a client following redirects needs no special handling,
        // but one that inspects the first response does.
        signedRedirects: config.storage.driver === "s3",
      },
      // `role` is what THIS request may do — for a token, already capped
      // below the account's own; `via` says which credential answered.
      viewer: me
        ? {
            id: me.id,
            username: me.username,
            role: me.role,
            via: authViaFromHeaders(req.headers),
          }
        : null,
    });
  } catch (err) {
    return serverError(err);
  }
}
