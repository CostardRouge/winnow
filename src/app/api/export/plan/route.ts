// POST /api/export/plan { filter } → the composition of what an export of this
// selection COULD copy, aggregated by category (cf. lib/exportTypes.ts) with a
// per-extension breakdown and cumulated sizes. The export modal calls this on
// open to build its dynamic "files to include" picker — a row per category the
// selection actually holds, nothing hardcoded. Shares collectExportFiles with
// the worker, so what the modal shows is exactly what the worker considers.
import { NextRequest } from "next/server";
import { z } from "zod";
import { FilterSchema } from "@/lib/filter";
import { collectExportFiles } from "@/lib/export";
import type { ExportPlan, ExportPlanGroup } from "@/lib/exportTypes";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const Body = z.object({
  filter: FilterSchema.default({}),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success)
      return badRequest("Invalid parameters", parsed.error.issues);

    const files = await collectExportFiles(parsed.data.filter);

    const groups = new Map<string, ExportPlanGroup>();
    let assets = 0;
    for (const f of files) {
      if (f.sidecar_id == null) assets++;
      let g = groups.get(f.category);
      if (!g) {
        g = { category: f.category, count: 0, bytes: 0, exts: [] };
        groups.set(f.category, g);
      }
      g.count++;
      g.bytes += Number(f.file_size) || 0;
      const ext = f.ext.replace(/^\./, "").toUpperCase() || "?";
      const e = g.exts.find((x) => x.ext === ext);
      if (e) e.count++;
      else g.exts.push({ ext, count: 1 });
    }
    // Stable chips: most frequent extension first within each row.
    for (const g of groups.values()) g.exts.sort((a, b) => b.count - a.count);

    const plan: ExportPlan = { assets, groups: [...groups.values()] };
    return json(plan);
  } catch (err) {
    return serverError(err);
  }
}
