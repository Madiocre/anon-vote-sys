import { env as workerEnv } from "cloudflare:workers";

import type { Env as ServerEnv } from "../server/env.ts";

/**
 * Astro 6+ exposes Worker bindings through the `cloudflare:workers` module
 * rather than `Astro.locals.runtime.env`, and the execution context through
 * `Astro.locals.cfContext` (`Astro.locals.runtime.ctx` was removed outright —
 * the adapter throws a migration error if you reach for it).
 *
 * `workerEnv` is typed by the generated global `Env` in
 * worker-configuration.d.ts, which is derived from wrangler.jsonc. `ServerEnv`
 * is the hand-written contract src/server/ codes against, and it additionally
 * declares the three secrets, which never appear in wrangler.jsonc and so never
 * make it into the generated type. This is the single place the two are
 * reconciled — if they drift, it surfaces here rather than in every page.
 */
export const env = workerEnv as unknown as ServerEnv;

/** The ExecutionContext, needed for `waitUntil` when populating the edge cache. */
export function cfContext(locals: App.Locals): ExecutionContext {
  return locals.cfContext;
}
