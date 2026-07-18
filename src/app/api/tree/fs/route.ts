// GET /api/tree/fs?path=<dir>&<filters> → immediate child directories of <dir>
// that hold indexed media, with recursive counts and an `expandable` flag —
// a lazy, real-filesystem tree derived from assets.abs_path (which is always
// root.path + '/' + rel_path, cf. lib/indexer.ts). Omit `path` to get the scan
// roots (the tree's top level). Drives the Pipeline folder view: each node
// scopes the grid via the `under` filter, and expands one level at a time so a
// directory with hundreds of children never loads all at once.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import { json, serverError } from "@/lib/api";

type FsNode = {
  path: string;
  name: string;
  count: number;
  expandable: boolean;
};

// Escapes LIKE wildcards so a literal % / _ / \ in a real path matches itself.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Last path segment (the folder's own name), for the node label.
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const path = sp.get("path");
    const filter = filterFromSearchParams(sp);

    if (!path) {
      // Top level: the scan roots that actually hold live (matching) media.
      const { conditions, params } = buildFilter(filter, 1);
      const where = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const rows = await many<{ path: string; count: number }>(
        `SELECT rt.path AS path, count(*)::int AS count
           FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
           JOIN sessions s ON s.id = a.session_id
           JOIN roots rt ON rt.id = s.root_id
           ${where}
          GROUP BY rt.path
          ORDER BY rt.path`,
        params,
      );
      const nodes: FsNode[] = rows.map((r) => ({
        path: r.path.replace(/\/+$/, ""),
        name: basename(r.path),
        count: r.count,
        expandable: true,
      }));
      return json({ nodes });
    }

    // Children of `path`: the distinct next path segment among assets living in a
    // subdirectory of it. `$1` (raw prefix) drives the substring offset; `$2`
    // (escaped prefix + "/%") the strict-descendant match. `rest` is the tail
    // after the child segment — a further "/" in it means the child has its own
    // subdirectories (so it's expandable), otherwise it only holds files.
    const prefix = path.replace(/\/+$/, "");
    const { conditions, params } = buildFilter(filter, 3);
    const extra = conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
    const rows = await many<{
      name: string;
      count: number;
      expandable: boolean;
    }>(
      `WITH sub AS (
         SELECT substring(a.abs_path FROM char_length($1) + 2) AS tail
           FROM assets a
           LEFT JOIN ratings r ON r.asset_id = a.id
          WHERE a.abs_path LIKE $2 ESCAPE '\\'${extra}
       ),
       seg AS (
         SELECT split_part(tail, '/', 1) AS name,
                substring(tail FROM strpos(tail, '/') + 1) AS rest
           FROM sub
          WHERE strpos(tail, '/') > 0
       )
       SELECT name,
              count(*)::int AS count,
              bool_or(strpos(rest, '/') > 0) AS expandable
         FROM seg
        GROUP BY name
        ORDER BY name`,
      [prefix, `${escapeLike(prefix)}/%`, ...params],
    );
    const nodes: FsNode[] = rows.map((r) => ({
      path: `${prefix}/${r.name}`,
      name: r.name,
      count: r.count,
      expandable: r.expandable,
    }));
    return json({ nodes });
  } catch (err) {
    return serverError(err);
  }
}
