import type { VoteGate } from "./durable-objects/vote-gate";
import type { RateLimiter } from "./durable-objects/rate-limiter";
import { DEFAULT_RESULTS_TTL_SECONDS } from "@avs/shared";

export interface Env {
  // Bindings
  DB: D1Database;
  VOTE_GATE: DurableObjectNamespace<VoteGate>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** Native Workers rate limiting binding declared under "ratelimits" in wrangler.jsonc. */
  EDGE_RATE_LIMITER: RateLimit;

  // Secrets — `wrangler secret put <NAME>` in production, apps/web/.dev.vars locally.
  VOTE_SALT: string;
  COOKIE_SECRET: string;
  TURNSTILE_SECRET: string;

  // Vars — declared under "vars" in wrangler.jsonc. Optional here because a var
  // is technically absent until wrangler.jsonc sets it; resultsTtl() below is
  // what actually enforces a value at runtime.
  RESULTS_TTL_SECONDS?: string;
}

/**
 * Minimal shape covering both the raw Cloudflare ExecutionContext and Hono's
 * `c.executionCtx` — callers pass whichever they have, cache.ts only ever needs
 * `waitUntil`.
 */
export interface WaitUntil {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function resultsTtl(env: Env): number {
  const parsed = Number(env.RESULTS_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESULTS_TTL_SECONDS;
}

/** Throws with a clear message naming the missing binding, instead of a bare `undefined` later. */
export function requireSecret(env: Env, name: keyof Env): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required secret/var: ${String(name)}`);
  }
  return value;
}