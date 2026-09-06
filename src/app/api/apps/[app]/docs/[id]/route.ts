// GET    /api/apps/:app/docs/:id → 200 + ETag; If-None-Match current → 304;
//                                  404 when the row is not the caller's.
// PUT    /api/apps/:app/docs/:id { kind, version, doc } → 200 { etag,
//                                  updated_at } (+ ETag). Existing row and
//                                  If-Match missing or stale → 412 { error,
//                                  etag, updated_at }. Body over the cap → 413.
//                                  Not application/json → 415.
// DELETE /api/apps/:app/docs/:id  with If-Match → 204; stale → 412; 404 when
//                                  not owned.
//
// The revision dance is the whole point: a client on another device that
// holds a stale etag is REFUSED and told the current one, and it decides —
// last-write-wins with a refusal, never a merge. The rules and the SQL live
// in lib/appDocuments.ts; this file only maps outcomes to status codes.
//
// `Content-Type: application/json` is required on the PUT on purpose: it
// forces the browser to preflight, and only an allowlisted origin passes
// (lib/cors.ts) — the CSRF story for the first mutating cross-origin route.
import { NextRequest, NextResponse } from "next/server";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import {
  MAX_DOC_BYTES,
  deleteDocument,
  getDocument,
  isDocKind,
  isValidApp,
  isValidDocId,
  normalizeEtag,
  putDocument,
  quoteEtag,
} from "@/lib/appDocuments";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ app: string; id: string }> };

function conflict(etag: string, updated_at: string) {
  return NextResponse.json(
    { error: "changed since the revision you hold", etag, updated_at },
    { status: 412, headers: { ETag: quoteEtag(etag) } },
  );
}

async function resolve(req: NextRequest, params: Params["params"]) {
  const me = identityFromHeaders(req.headers);
  if (!me) return { error: json({ error: "authentication required" }, 401) };
  const { app, id } = await params;
  if (!isValidApp(app)) return { error: badRequest("bad app") };
  if (!isValidDocId(id)) return { error: badRequest("bad id") };
  return { me, app, id };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;
    const row = await getDocument(r.me.id, r.app, r.id);
    if (!row) return notFound();
    const etag = quoteEtag(row.etag);
    if (normalizeEtag(req.headers.get("if-none-match")) === row.etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }
    return NextResponse.json(row, { headers: { ETag: etag } });
  } catch (err) {
    return serverError(err);
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;

    const type = req.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(type)) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }
    // The declared length first (cheap, refuses before reading), then the
    // real one: a client can lie about the header, not about the bytes.
    const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
      return json({ error: `body over ${MAX_DOC_BYTES} bytes` }, 413);
    }
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_DOC_BYTES) {
      return json({ error: `body over ${MAX_DOC_BYTES} bytes` }, 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return badRequest("body is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return badRequest("body must be an object");
    }
    const b = parsed as { kind?: unknown; version?: unknown; doc?: unknown };
    if (!isDocKind(b.kind)) return badRequest("unknown kind");
    if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 0) {
      return badRequest("version must be a non-negative integer");
    }
    if (typeof b.doc !== "object" || b.doc === null) return badRequest("doc must be an object");

    const outcome = await putDocument(
      r.me.id,
      r.app,
      r.id,
      { kind: b.kind, version: b.version, doc: b.doc },
      normalizeEtag(req.headers.get("if-match")),
    );
    switch (outcome.status) {
      case "notfound":
        return notFound();
      case "conflict":
        return conflict(outcome.etag, outcome.updated_at);
      case "ok":
        return NextResponse.json(
          { etag: outcome.etag, updated_at: outcome.updated_at },
          { status: outcome.created ? 201 : 200, headers: { ETag: quoteEtag(outcome.etag) } },
        );
    }
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;
    const outcome = await deleteDocument(
      r.me.id,
      r.app,
      r.id,
      normalizeEtag(req.headers.get("if-match")),
    );
    switch (outcome.status) {
      case "notfound":
        return notFound();
      case "conflict":
        return conflict(outcome.etag, outcome.updated_at);
      case "ok":
        return new NextResponse(null, { status: 204 });
    }
  } catch (err) {
    return serverError(err);
  }
}
