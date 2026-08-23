import type { APIRoute } from "astro";

import app from "../../server/index.ts";
import { cfContext, env } from "../../lib/runtime.ts";

export const prerender = false;

/**
 * Every /api/* request is handed straight to the Hono app with the Worker's own
 * env and execution context. Same origin as the pages, so cookies need no
 * SameSite=None and there is no CORS layer to get wrong.
 *
 * The import is a relative path into src/server/ rather than a workspace
 * package — src/server/ is deliberately not its own package (AGENTS.md §1).
 */
export const ALL: APIRoute = ({ request, locals }) =>
  app.fetch(request, env, cfContext(locals));
