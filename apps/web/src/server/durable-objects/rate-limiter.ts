import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

interface RateLimitState {
  count: number;
  windowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Fixed-window counter, one instance per (identity, route) key — built by
 * middleware/rate-limit.ts. This is the authoritative, globally-consistent
 * layer: unlike the native EDGE_RATE_LIMITER binding,
 * a DO instance is pinned to one location and single-threaded, 
 * so it's the actual single source of truth for the count,
 * not an approximation of it.
 * limit/windowMs are passed in per call rather than hardcoded, so one class
 * serves every route at whatever limit that route's middleware config asks
 * for — /api/vote and /api/status don't need separate DO classes just because
 * they want different limits.
 */
export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async checkLimit(limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const state = (await this.ctx.storage.get<RateLimitState>("state")) ?? {
      count: 0,
      windowStart: now,
    };

    if (now - state.windowStart >= windowMs) {
      state.count = 0;
      state.windowStart = now;
    }

    // Increment regardless of outcome — a rejected request still counts against
    // the window, matching how the edge binding behaves.
    state.count += 1;
    await this.ctx.storage.put("state", state);

    return {
      allowed: state.count <= limit,
      remaining: Math.max(0, limit - state.count),
    };
  }
}