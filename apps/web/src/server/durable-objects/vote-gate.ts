import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * One instance per voter, addressed by ip_hash (see index.ts's vote handler for
 * how the id is derived — not by anything this class needs to know about).
 * First claim wins; every call after the first returns false.
 *
 * This is the fast, globally-consistent FIRST gate, not the source of truth —
 * the UNIQUE indexes on packages/db/src/schema.ts's votes table remain that.
 * A DO instance is pinned to one location and serializes its own calls, so two
 * concurrent requests from the same voter cannot both slip through here the way
 * they theoretically could between two racing D1 reads — but the D1 constraint
 * is still what recordVote() falls back on, so this DO being briefly
 * unavailable degrades to "D1 catches it instead," not "the dedup breaks."
 */
export class VoteGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** True on the first call for this instance, false on every call after. */
  async claim(): Promise<boolean> {
    const alreadyClaimed = await this.ctx.storage.get<boolean>("claimed");
    if (alreadyClaimed) return false;

    await this.ctx.storage.put("claimed", true);
    return true;
  }
}