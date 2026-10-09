// GET  /api/pipeline/track-import → the applied imports, newest first, with
//      what each still holds (frames placed, frames zoned).
// POST /api/pipeline/track-import (multipart) files=<one or more>, apply?,
//      name? → read the files as ONE GPS track (a Polarsteps export's
//      locations.json + trip.json, GPX, or a {lat, lon, time} JSON list —
//      lib/trackParse.ts) and match every live frame of its span
//      (lib/trackImport.ts). Without `apply=true` nothing is written: the
//      answer is the report a human reads before applying.
//
// Runs inline: it is database-only (the track is in the request, no original
// is read), a span of a year is one indexed read and a few batched updates.
// Admin-only by policy (lib/authz.ts: /api/pipeline mutations are admin).
import { NextRequest } from "next/server";
import { listTrackImports, runTrackImport } from "@/lib/trackImport";
import { parseTrackFiles, TrackParseError } from "@/lib/trackParse";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

/** A year of a dense track is a few MB; refuse what is clearly not a track. */
const MAX_BYTES = 64 * 1024 * 1024;

export async function GET() {
  try {
    return json({ imports: await listTrackImports() });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return badRequest("expected a multipart form with one or more files");
    }
    const files: { name: string; text: string }[] = [];
    let total = 0;
    for (const v of form.getAll("files")) {
      if (typeof v === "string") continue;
      total += v.size;
      if (total > MAX_BYTES) return badRequest("these files are too large to be a GPS track");
      files.push({ name: v.name, text: await v.text() });
    }
    if (!files.length) return badRequest("no file received");
    let track;
    try {
      track = parseTrackFiles(files);
    } catch (e) {
      if (e instanceof TrackParseError) return badRequest(e.message);
      throw e;
    }
    const nameField = form.get("name");
    const report = await runTrackImport(track, {
      apply: form.get("apply") === "true",
      name: typeof nameField === "string" && nameField.trim() ? nameField.trim() : undefined,
    });
    return json({ report });
  } catch (err) {
    return serverError(err);
  }
}
