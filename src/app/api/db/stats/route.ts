// GET /api/db/stats -> what the database physically holds: per-table sizes
// (heap / TOAST / indexes) with row estimates, exact on-disk weight of the
// known-heavy columns (face/CLIP embeddings, OCR text), the sidecar's backup
// files, and whether an in-app pg_dump is possible. Read-only dashboard data
// for Settings › Database — the "am I about to download 5 GB?" answer before
// a risky migration.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { many, one } from "@/lib/db";
import { listBackups } from "@/lib/backups";
import { json, serverError } from "@/lib/api";

// DB/FS-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const execFileP = promisify(execFile);

type TableRow = {
  name: string;
  approx_rows: number;
  total_bytes: number;
  heap_bytes: number;
  toast_bytes: number;
  index_bytes: number;
};

// The columns worth measuring EXACTLY: the embedding/text payloads that grow
// with ML analysis and dominate the database long before row counts look
// scary. pg_column_size() reports the stored (TOAST-compressed) size, i.e.
// what the disk — and a backup download — actually pays. An entry is skipped
// when its table doesn't exist (asset_clip needs pgvector, cf. migration 0030).
const HEAVY_COLUMNS: { table: string; column: string; label: string }[] = [
  {
    table: "asset_faces",
    column: "embedding",
    label: "Face recognition embeddings (512-dim JSONB, one per detected face)",
  },
  {
    table: "asset_clip",
    column: "embedding",
    label: "CLIP image embeddings (pgvector, one per analyzed media)",
  },
  {
    table: "assets",
    column: "ocr_text",
    label: "OCR text read in images",
  },
];

// Whether this container can take a dump itself: pg_dump must exist AND its
// major version must be >= the server's (pg_dump refuses to dump a newer
// server). Surfaced to the UI so the "Download backup" button can explain
// itself instead of failing on click.
async function dumpCapability(serverVersionNum: number) {
  const serverMajor = Math.floor(serverVersionNum / 10000);
  try {
    const { stdout } = await execFileP("pg_dump", ["--version"]);
    const m = stdout.match(/(\d+)(?:\.\d+)?/);
    const clientMajor = m ? Number.parseInt(m[1], 10) : 0;
    return {
      available: clientMajor >= serverMajor,
      clientMajor,
      serverMajor,
      reason:
        clientMajor >= serverMajor
          ? null
          : `pg_dump is v${clientMajor} but the server is v${serverMajor} — rebuild the app image (it installs the matching postgresql-client).`,
    };
  } catch {
    return {
      available: false,
      clientMajor: null,
      serverMajor,
      reason:
        "pg_dump is not installed in this container — rebuild the app image, or use scripts/pg-backup.sh / the backup sidecar (docs/BACKUP.md).",
    };
  }
}

export async function GET() {
  try {
    const overview = await one<{
      db_bytes: number;
      server_version: string;
      server_version_num: number;
      pgvector: boolean;
    }>(
      `SELECT pg_database_size(current_database())            AS db_bytes,
              current_setting('server_version')               AS server_version,
              current_setting('server_version_num')::int      AS server_version_num,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS pgvector`,
    );

    // One row per user table: planner row estimate + size split. heap = the
    // main relation, toast = the out-of-line storage where big values (JSONB
    // embeddings, long text) actually live, indexes = all of them together.
    // pg_total_relation_size covers heap+toast+indexes (+FSM/VM), so the split
    // can undershoot the total by a few pages — cosmetic, not worth chasing.
    const tables = await many<TableRow>(
      `SELECT c.relname                                            AS name,
              c.reltuples::bigint                                  AS approx_rows,
              pg_total_relation_size(c.oid)                        AS total_bytes,
              pg_relation_size(c.oid)                              AS heap_bytes,
              CASE WHEN c.reltoastrelid <> 0
                   THEN pg_total_relation_size(c.reltoastrelid)
                   ELSE 0 END                                      AS toast_bytes,
              pg_indexes_size(c.oid)                               AS index_bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
        ORDER BY pg_total_relation_size(c.oid) DESC, c.relname`,
    );

    // reltuples is -1 until the table's first VACUUM/ANALYZE. For small tables
    // an exact count is instant and better than a dash; a big never-analyzed
    // table (fresh bulk load) keeps the dash rather than a surprise seq scan.
    for (const t of tables) {
      if (t.approx_rows < 0 && t.total_bytes < 64 * 1024 * 1024) {
        const r = await one<{ n: number }>(
          `SELECT count(*)::bigint AS n FROM ${quoteIdent(t.name)}`,
        );
        if (r) t.approx_rows = r.n;
      }
    }

    // Exact weight of the heavy columns — one seq scan per column, cheap at
    // this library's scale (pg_column_size reads stored lengths, not values).
    const heavy: {
      table: string;
      column: string;
      label: string;
      rows: number;
      bytes: number;
    }[] = [];
    for (const h of HEAVY_COLUMNS) {
      const exists = await one<{ ok: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS ok`,
        [`public.${h.table}`],
      );
      if (!exists?.ok) continue;
      const r = await one<{ rows: number; bytes: number }>(
        `SELECT count(${quoteIdent(h.column)})::bigint                            AS rows,
                coalesce(sum(pg_column_size(${quoteIdent(h.column)})), 0)::bigint AS bytes
           FROM ${quoteIdent(h.table)}`,
      );
      if (r) heavy.push({ table: h.table, column: h.column, label: h.label, ...r });
    }

    const migrations = await one<{ count: number; last: string | null }>(
      `SELECT count(*)::bigint AS count, max(name) AS last FROM schema_migrations`,
    );

    const [backups, dump] = await Promise.all([
      listBackups(),
      dumpCapability(overview?.server_version_num ?? 0),
    ]);

    return json({
      database: {
        sizeBytes: overview?.db_bytes ?? 0,
        serverVersion: overview?.server_version ?? "unknown",
        pgvector: overview?.pgvector ?? false,
        migrations: {
          count: migrations?.count ?? 0,
          last: migrations?.last ?? null,
        },
      },
      tables: tables.map((t) => ({
        name: t.name,
        approxRows: t.approx_rows,
        totalBytes: t.total_bytes,
        heapBytes: t.heap_bytes,
        toastBytes: t.toast_bytes,
        indexBytes: t.index_bytes,
      })),
      heavyColumns: heavy,
      backups,
      dump,
    });
  } catch (err) {
    return serverError(err);
  }
}

// Postgres identifier quoting for names read back from pg_class. They are
// already trusted (they exist in the catalog); this just keeps odd names from
// breaking the query text.
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
