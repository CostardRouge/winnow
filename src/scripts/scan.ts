// Helper CLI : enregistre un root (s'il n'existe pas) et lance une indexation.
// Usage : npm run scan -- /chemin/vers/dossier/NAS [--sync]
//   --sync : indexe directement dans ce process (sans passer par Redis/worker)
import { one } from "../lib/db";
import { pool } from "../lib/db";
import { enqueueIndex } from "../lib/queue";
import { indexRoot } from "../lib/indexer";
import { closeExiftool } from "../lib/extract";
import path from "node:path";

async function main() {
  const args = process.argv.slice(2);
  const sync = args.includes("--sync");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("Usage : npm run scan -- /chemin/dossier [--sync]");
    process.exit(1);
  }
  const abs = path.resolve(target);

  const root = await one<{ id: number }>(
    `INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', true)
     ON CONFLICT (path) DO UPDATE SET path = EXCLUDED.path
     RETURNING id`,
    [abs],
  );

  if (sync) {
    console.log(`Indexation synchrone de ${abs}…`);
    const res = await indexRoot(root!.id);
    console.log(res);
    await closeExiftool();
  } else {
    await enqueueIndex(root!.id);
    console.log(`Indexation enfilée pour le root ${root!.id} (${abs}).`);
    console.log("Lance `npm run worker` pour la traiter.");
  }
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
