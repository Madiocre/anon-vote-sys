/**
 * Custom Worker entrypoint (AGENTS.md §2).
 *
 * Astro's stock Cloudflare entrypoint exports a `fetch` handler and nothing
 * else, so a Durable Object class declared in wrangler.jsonc has no export for
 * the runtime to bind to. That is not just a deploy-time problem: the adapter
 * prerenders in workerd, so `astro build` boots miniflare with the full config
 * and dies with "Class extends value undefined is not a constructor" long
 * before you get near a deploy.
 *
 * This file exists to re-export both DO classes alongside the handler. Note it
 * is a plain object with direct named exports — NOT the `createExports()`
 * wrapper from pre-13 `@astrojs/cloudflare`, and not the `workerEntryPoint`
 * adapter option either (that option does not exist in 14.2.3; the adapter
 * simply honours whatever `main` wrangler.jsonc sets, defaulting to its own
 * entrypoint when unset).
 */

import { handle } from "@astrojs/cloudflare/handler";

import { RateLimiter } from "./server/durable-objects/rate-limiter";
import { VoteGate } from "./server/durable-objects/vote-gate";

export { VoteGate, RateLimiter };

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
