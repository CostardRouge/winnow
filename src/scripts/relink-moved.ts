// CLI helper: repair assets whose original was MOVED on disk (a folder
// reorganisation), which the pipeline currently reads as "file deleted" +
// "unknown duplicate" and can never undo on its own — cf. lib/relink.ts for the
// mechanism and docs/memory/pipeline.md for why it is a stable deadlock.
//
// Matches each orphaned row to the file that now holds its content (size
// prefilter, then the same partial hash the indexer dedups on) and moves the
// row onto it, keeping its id — hence its rating, tags, pairing, burst and edit
// links, and its already-built derivatives.
//
// PURGED ROWS ARE INCLUDED. Purging missing files does not release their
// content_hash, so it leaves the moved file unindexable forever; this brings
// those rows back and re-queues the derivative + ML pass a purge destroyed.
//
// Usage:
//   npm run relink-moved                    # DRY RUN — reports, writes nothing
//   npm run relink-moved -- --apply         # actually relink
//   npm run relink-moved -- --root 2        # scope to one volume
//   npm run relink-moved -- --limit 20      # show more of the match list
// Then run `npm run worker` (or leave it running) to rebuild what was purged.
import { pool } from "../lib/db";
import { relinkMoved } from "../lib/relink";
import type { RelinkReport } from "../lib/relink";

// How many matches/skips to print by default: enough to eyeball a repair, short
// enough that a 900-file reorganisation does not scroll the summary away.
const DEFAULT_LIMIT = 10;

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printReport(report: RelinkReport, limit: number): void {
  console.log(
    `  walked ${report.scanned} media file(s), ${report.unindexed} unindexed, ` +
      `${report.hashed} hashed → ${report.matched} match(es)`,
  );

  for (const m of report.matches.slice(0, limit)) {
    const tag = m.state === "purged" ? " [purged — needs a rebuild]" : "";
    console.log(`    #${m.assetId} ${m.filename}${tag}`);
    console.log(`        from ${m.oldPath}`);
    console.log(`          to ${m.newPath}`);
  }
  const shown = Math.min(limit, report.matches.length);
  if (report.matched > shown)
    console.log(`    … and ${report.matched - shown} more`);

  if (report.ambiguous)
    console.log(`  ${report.ambiguous} ambiguous — left untouched`);

  for (const s of report.skipped.slice(0, limit))
    console.log(`  skipped ${s.path}: ${s.reason}`);
  const shownSkips = Math.min(limit, report.skipped.length);
  if (report.skippedCount > shownSkips)
    console.log(`  … and ${report.skippedCount - shownSkips} more skipped`);

  if (report.applied)
    console.log(
      `  relinked ${report.relinked}, queued ${report.derivativesQueued} derivative(s), ` +
        `re-recorded ${report.sidecarsRecorded} sidecar(s)`,
    );
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const rootArg = arg("root");
  const rootId = rootArg ? Number(rootArg) : undefined;
  const limit = Number(arg("limit") ?? DEFAULT_LIMIT);

  if (rootArg && !Number.isFinite(rootId)) {
    console.error(`--root expects a root id, got "${rootArg}"`);
    process.exit(1);
  }

  console.log(
    apply
      ? "Relinking moved originals…"
      : "DRY RUN — nothing will be written. Re-run with --apply to repair.",
  );

  const { perRoot } = await relinkMoved({ rootId, apply });

  if (!perRoot.length) {
    console.log("No walkable volume in scope (source/finals only).");
    await pool.end();
    process.exit(0);
  }

  let matched = 0;
  let relinked = 0;
  let rebuilds = 0;
  for (const { root, report } of perRoot) {
    console.log(`\nroot ${root.id} (${root.kind}) ${root.path}`);
    if (!report.orphans) {
      console.log("  no asset is flagged missing — nothing to repair");
      continue;
    }
    console.log(`  ${report.orphans} orphaned row(s) in scope`);
    printReport(report, limit);
    matched += report.matched;
    relinked += report.relinked;
    rebuilds += report.rebuilds;
  }

  console.log("");
  if (!apply) {
    console.log(
      matched
        ? `${matched} file(s) would be relinked (${rebuilds} need a derivative + ML rebuild). ` +
            `Re-run with --apply.`
        : "Nothing to relink.",
    );
  } else {
    console.log(
      `Relinked ${relinked} asset(s). Run \`npm run worker\` to rebuild the ` +
        `${rebuilds} purged derivative(s) — ML re-runs on its own once each ` +
        `derivative is built.`,
    );
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
