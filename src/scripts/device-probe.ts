// CLI helper: read the camera every unread clip names in its own metadata
// track (migration 0049). The counterpart of Settings › Pipeline › Devices ›
// "Ask the clips themselves" — the button is the interface (docs/memory: a
// repair needing SSH does not exist), this is for a dev box. Thin wrapper
// over lib/deviceProbe.ts; it does not share the scan's hourly budget.
//
// Usage:
//   npm run device-probe
import { pool } from "../lib/db";
import { runDeviceProbe } from "../lib/deviceProbe";

async function main() {
  console.log("Reading the clips' own metadata tracks…");
  const r = await runDeviceProbe();
  console.log(JSON.stringify(r, null, 2));
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
