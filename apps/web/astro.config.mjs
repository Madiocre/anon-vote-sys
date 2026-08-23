// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // Required, and less optional than it looks. Astro 7 defaults to
  // output: "static", and in that mode it does not emit a server entry at all —
  // routes marked `export const prerender = false` are silently skipped rather
  // than built, dist/server comes out empty, and wrangler falls back to its
  // no-op worker template. That fallback is what makes both Durable Objects
  // fail to register ("...not exported in your entrypoint file"), since the
  // no-op worker naturally exports neither.
  //
  // With "server", pages are on-demand by default and opt into prerendering
  // with `export const prerender = true` — the right default here anyway: the
  // ballot and the live results page are both dynamic, and
  // src/pages/api/[...route].ts must be server-rendered to reach Hono at all.
  output: 'server',

  // No `workerEntryPoint` option — it does not exist in @astrojs/cloudflare
  // 14.2.3 despite what older notes claim. The entrypoint comes from `main` in
  // wrangler.jsonc, which the adapter honours and only defaults when unset.
  adapter: cloudflare(),
});
