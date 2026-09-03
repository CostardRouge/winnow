// GET  /api/timeline/chapters → every named span (the human corrections that
//                               rename / merge / locate a derived chapter).
// POST /api/timeline/chapters { starts_at, ends_at, name?, place_label?,
//                               place_lat?, place_lon? } → creates one.
//
// A span is a CORRECTION applied on top of the derivation, never a stored
// chapter (cf. migration 0040, lib/timeline.ts): everything captured inside
// [starts_at, ends_at] becomes one chapter with this name. Renaming a derived
// chapter and merging two neighbours are both "create a span over that range".
//
// The location fields describe the CHAPTER. This route writes nothing on
// assets and arms no EXIF write-back — placing the chapter's GPS-less media at
// that point is a separate, explicit gesture through api/assets/geotag.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const spans = await many(
      `SELECT id, starts_at, ends_at, name, place_label, place_lat, place_lon,
              created_at, updated_at
       FROM timeline_chapters ORDER BY starts_at`,
    );
    return json({ spans });
  } catch (err) {
    return serverError(err);
  }
}

// Not exported: a route module may only export handlers and config.
const iso = z.string().datetime({ offset: true });
const SpanBody = z
  .object({
    starts_at: iso,
    ends_at: iso,
    name: z.string().trim().min(1).max(120).nullable().optional(),
    place_label: z.string().trim().min(1).max(200).nullable().optional(),
    place_lat: z.number().min(-90).max(90).nullable().optional(),
    place_lon: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((b) => Date.parse(b.ends_at) >= Date.parse(b.starts_at), {
    message: "ends_at must not precede starts_at",
  })
  .refine((b) => (b.place_lat == null) === (b.place_lon == null), {
    message: "place_lat and place_lon come together",
  });

export async function POST(req: NextRequest) {
  try {
    const parsed = SpanBody.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid span", parsed.error.issues);
    const b = parsed.data;

    // Two spans must not overlap: a run inside both would have two names.
    // The client merges or resets first; the server just refuses.
    const clash = await one<{ id: number }>(
      `SELECT id FROM timeline_chapters
       WHERE starts_at <= $2 AND ends_at >= $1 LIMIT 1`,
      [b.starts_at, b.ends_at],
    );
    if (clash) return badRequest("Overlaps an existing chapter", { id: clash.id });

    const span = await one(
      `INSERT INTO timeline_chapters
         (starts_at, ends_at, name, place_label, place_lat, place_lon)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, starts_at, ends_at, name, place_label, place_lat, place_lon`,
      [b.starts_at, b.ends_at, b.name ?? null, b.place_label ?? null, b.place_lat ?? null, b.place_lon ?? null],
    );
    return json({ span }, 201);
  } catch (err) {
    return serverError(err);
  }
}
