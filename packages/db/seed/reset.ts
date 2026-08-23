/**
 * Clears the votes table on the LOCAL database so you can test the flow again
 * without hunting down cookies.
 *
 *   bun run reset:local
 *
 * Deliberately has no --remote switch. Wiping a live public vote should be a
 * conscious, hand-typed `wrangler d1 execute ... --remote` and not one keystroke
 * away from a habit.
 */

import { resolve } from "node:path";

const HERE = import.meta.dirname;
const PKG_ROOT = resolve(HERE, "..");
const WRANGLER_CONFIG = resolve(PKG_ROOT, "../../apps/web/wrangler.jsonc");

const proc = Bun.spawnSync({
  cmd: [
    // See seed.ts — "bunx" is not spawnable on Windows.
    process.execPath,
    "x",
    "wrangler",
    "d1",
    "execute",
    "anon-vote-sys",
    "--local",
    "--config",
    WRANGLER_CONFIG,
    "--command",
    "DELETE FROM votes;",
  ],
  cwd: PKG_ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});

if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);

console.log("Local votes cleared. Candidates left intact.");
console.log("Your browser still holds a vote cookie — clear it or use a private window.");
