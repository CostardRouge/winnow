// GET  /api/roots                          → dossiers enregistrés (sources + finaux)
// POST /api/roots { path, kind, watch }     → enregistre un répertoire
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { enqueueIndex } from "@/lib/queue";
import { json, badRequest, serverError } from "@/lib/api";
import type { Root } from "@/lib/types";

// Route adossée à la DB : jamais pré-rendue/mise en cache au build.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const roots = await many<Root>(
      "SELECT * FROM roots ORDER BY added_at DESC",
    );
    return json({ roots });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  path: z.string().min(1),
  kind: z.enum(["source", "finals"]).default("source"),
  watch: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Paramètres invalides", parsed.error.issues);
    const { path, kind, watch } = parsed.data;
    const root = await one<Root>(
      `INSERT INTO roots (path, kind, watch) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET kind = EXCLUDED.kind, watch = EXCLUDED.watch
       RETURNING *`,
      [path, kind, watch],
    );
    // Sources ET finaux sont indexés (les finaux pour générer leurs miniatures,
    // afin d'être consultables). L'inbox n'est jamais enregistré via cette route.
    await enqueueIndex(root!.id);
    return json({ root }, 201);
  } catch (err) {
    return serverError(err);
  }
}
