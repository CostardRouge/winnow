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
import { identityFromHeaders } from "@/lib/auth";
import { json, serverError } from "@/lib/api";
import { DOC_KINDS, MAX_DOC_BYTES } from "@/lib/appDocuments";
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
        // The session cookie is the only credential. A same-site client app
        // gets it for free through CORS (lib/cors.ts); a foreign origin has
        // nothing yet — `token`/`oauth2` would be added here when built.
        methods: ["cookie"],
        corsEnabled: config.cors.allowedOrigins.length > 0,
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
      viewer: me
        ? { id: me.id, username: me.username, role: me.role }
        : null,
    });
  } catch (err) {
    return serverError(err);
  }
}
