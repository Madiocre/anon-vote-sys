import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { resolveIdentity } from "../lib/identity";

export interface RateLimitOptions {
  /** Folded into both keys below so each route gets its own independent counter. */
  route: string;
  limit: number;
  windowMs: number;
}

type Bindings = { Bindings: Env };

/**
 * Two layers, cheapest first (AGENTS.md §5):
 *  1. EDGE_RATE_LIMITER — the native binding, scoped per Cloudflare location.
 *     Absorbs an obvious burst hitting one colo without ever reaching a DO.
 *  2. RATE_LIMITER DO — the authoritative, globally-consistent check. Only
 *     reached once layer 1 has already passed, since it's the more expensive
 *     of the two (a DO round trip vs. a local binding call).
 *
 * Calls resolveIdentity() independently rather than reading it off something
 * upstream — the route handler resolves identity again for its own purposes,
 * so this duplicates one cheap hash computation (no I/O) rather than threading
 * state through Hono's context for a single reused value.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    const { ipHash } = await resolveIdentity(c.req.raw, c.env);
    const key = `${ipHash}:${options.route}`;

    const edge = await c.env.EDGE_RATE_LIMITER.limit({ key });
    if (!edge.success) {
      return c.text("Too many requests", 429);
    }

    const id = c.env.RATE_LIMITER.idFromName(key);
    const stub = c.env.RATE_LIMITER.get(id);
    const { allowed } = await stub.checkLimit(options.limit, options.windowMs);
    if (!allowed) {
      return c.text("Too many requests", 429);
    }

    await next();
  };
}