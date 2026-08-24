import type { Context, MiddlewareHandler } from "hono";

import type { VoteResponse } from "@avs/shared";

import type { Env } from "../env";
import { resolveIdentity } from "../lib/identity";

export interface RateLimitOptions {
  /** Folded into both keys so each route gets its own independent counter. */
  route: string;
  /** Per-VOTER budget for this route. Enforced by the Durable Object. */
  limit: number;
  windowMs: number;
}

type Bindings = { Bindings: Env };

/**
 * A 429 the ballot can actually read.
 *
 * It used to be `c.text("Too many requests", 429)`. The vote page parses the
 * response body as JSON and falls back to a generic "Your vote could not be
 * recorded. Please try again" when that fails — which told a rate-limited voter
 * to do the one thing guaranteed not to work. Matching the VoteFailure shape
 * lets the page show the real reason.
 */
function tooMany(c: Context<Bindings>) {
  const body: VoteResponse = {
    ok: false,
    error: "rate_limited",
    message: "Too many attempts in a short time. Wait a moment and try again.",
  };
  return c.json(body, 429);
}

/**
 * Two layers, deliberately keyed on DIFFERENT subjects.
 *
 *  1. EDGE_RATE_LIMITER — native binding, per Cloudflare location, keyed on
 *     ip_hash. A coarse flood guard only. Its ceiling lives in wrangler.jsonc
 *     and is set far above any plausible legitimate load from one address.
 *
 *  2. RATE_LIMITER DO — the authoritative per-voter budget, keyed on voter_id.
 *     Only reached once layer 1 passes, since a DO round trip costs more than a
 *     local binding call.
 *
 * ---------------------------------------------------------------------------
 * WHY LAYER 2 IS NOT KEYED ON ip_hash
 *
 * It used to be, at 5 requests per minute. That silently denies service at
 * scale, because a public IPv4 address is not one person:
 *
 *   * Carrier-grade NAT puts hundreds to thousands of mobile subscribers behind
 *     a single public IPv4. At country scale, one carrier egress address only
 *     needs six people voting in the same minute to start returning 429 — and
 *     the ballot renders that as "Your vote could not be recorded", because a
 *     429 carries no JSON body. Retrying does not help, and the voters most
 *     affected are exactly the mobile majority.
 *
 *   * A Durable Object is single-threaded. One instance per carrier IP means
 *     thousands of requests serialising through one object at peak. Keying on
 *     voter_id (a uuid) spreads that across as many instances as there are
 *     voters, which is what a DO is good at.
 *
 * voter_id comes from the `vid` cookie, which the ballot page sets on first
 * render — so a real voter always carries one by the time they POST a vote.
 *
 * FALLBACK: a request with no cookie gets a freshly minted voter_id on every
 * request, which would make a per-voter budget meaningless. Those fall back to
 * ip_hash keying, so cookie-blockers and scripted clients still hit a bound.
 * That reintroduces sharing for that traffic only, which is the correct place
 * to accept it: cookie-less requests are already anomalous.
 * ---------------------------------------------------------------------------
 *
 * Calls resolveIdentity() independently rather than reading it off something
 * upstream — the route handler resolves identity again for its own purposes,
 * so this duplicates one cheap hash computation (no I/O) rather than threading
 * state through Hono's context for a single reused value.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    const identity = await resolveIdentity(c.req.raw, c.env);

    // Layer 1 — coarse, per-IP, flood protection only.
    const edge = await c.env.EDGE_RATE_LIMITER.limit({
      key: `${identity.ipHash}:${options.route}`,
    });
    if (!edge.success) {
      return tooMany(c);
    }

    // Layer 2 — the real budget. Per voter when we can identify one, per IP
    // only for cookie-less clients (see FALLBACK above). `isNew` is true
    // precisely when the request arrived without a `vid` cookie.
    const subject = identity.isNew ? identity.ipHash : identity.voterId;
    const stub = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(`${subject}:${options.route}`),
    );

    const { allowed } = await stub.checkLimit(options.limit, options.windowMs);
    if (!allowed) {
      return tooMany(c);
    }

    await next();
  };
}
