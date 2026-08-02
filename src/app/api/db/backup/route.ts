// GET /api/db/backup -> a FRESH pg_dump of the whole database, streamed to the
// browser as winnow-<UTC ts>.sql.gz. Admin-only (cf. lib/authz.ts): the dump
// carries everything, password hashes and invite tokens included.
//
// Same format as the scheduled sidecar (plain SQL, --no-owner --no-privileges,
// gzipped) so ONE restore procedure covers both: scripts/pg-restore.sh and the
// docs/BACKUP.md runbook apply to a downloaded dump verbatim. The dump runs in
// its own connection (spawned pg_dump, not the pool), so the pool's 30 s
// statement_timeout never cuts a long dump short, and pg_dump's snapshot
// semantics give a consistent image even while workers keep writing.
//
// Nothing is written server-side: the bytes go pg_dump → gzip → response. The
// mounted backups dir stays read-only, and retention stays the sidecar's job.
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { json } from "@/lib/api";

export const dynamic = "force-dynamic";

// One dump at a time: a dump holds a snapshot + reads every table, so letting
// N concurrent clicks stack N of them is a self-inflicted outage. 429 instead.
let dumping = false;

export async function GET(req: NextRequest) {
  if (dumping) {
    return json({ error: "A backup is already being generated — try again in a moment." }, 429);
  }

  // Preflight the pg_dump <-> server version pairing so a mismatch is a clear
  // 503 with instructions, not a broken half-download. pg_dump refuses servers
  // NEWER than itself; dumping an older server is fine.
  let serverMajor = 0;
  try {
    const v = await one<{ n: number }>(
      `SELECT current_setting('server_version_num')::int AS n`,
    );
    serverMajor = Math.floor((v?.n ?? 0) / 10000);
  } catch (err) {
    return json({ error: `Database unreachable: ${(err as Error).message}` }, 503);
  }

  const clientMajor = await pgDumpMajor();
  if (clientMajor === null) {
    return json(
      {
        error:
          "pg_dump is not installed in this container. Rebuild the app image (the Dockerfile installs the matching postgresql-client), or take the dump with scripts/pg-backup.sh — see docs/BACKUP.md.",
      },
      503,
    );
  }
  if (clientMajor < serverMajor) {
    return json(
      {
        error: `pg_dump v${clientMajor} cannot dump a v${serverMajor} server. Rebuild the app image so the client matches, or use scripts/pg-backup.sh (it runs pg_dump inside the postgres container itself).`,
      },
      503,
    );
  }

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15); // YYYYMMDD-HHMMSS, UTC — same shape as the sidecar's names
  const filename = `winnow-${ts}.sql.gz`;

  dumping = true;
  const child = spawn(
    "pg_dump",
    ["--format=plain", "--no-owner", "--no-privileges", `--dbname=${config.databaseUrl}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Keep the tail of stderr for the log: if pg_dump dies mid-stream the HTTP
  // response is already committed, so the browser sees a truncated .gz (which
  // `gzip -t` catches — cf. the "spot-check a dump" section of the runbook)
  // and the real cause lands here.
  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const gzip = createGzip({ level: 6 });
  child.stdout.pipe(gzip);

  const release = () => {
    dumping = false;
  };
  child.on("close", (code) => {
    release();
    if (code !== 0) {
      console.error(`pg_dump exited with code ${code}: ${stderrTail}`);
      // Abort the gzip stream so the client sees a broken download, never a
      // silently-complete-looking file ending mid-table.
      gzip.destroy(new Error(`pg_dump exited with code ${code}`));
    }
  });
  child.on("error", (err) => {
    release();
    gzip.destroy(err);
  });

  // A canceled download must not leave a dump running against the database.
  req.signal.addEventListener("abort", () => {
    child.kill("SIGTERM");
  });

  return new NextResponse(Readable.toWeb(gzip) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function pgDumpMajor(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("pg_dump", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const m = out.match(/(\d+)(?:\.\d+)?/);
      resolve(m ? Number.parseInt(m[1], 10) : null);
    });
  });
}
