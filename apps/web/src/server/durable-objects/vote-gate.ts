import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * One instance per VOTER, addressed by voter_id (see index.ts's vote handler for
 * how the id is derived — not by anything this class needs to know about).
 * First claim wins; every call after the first returns false.
 *
 * It was previously addressed by ip_hash, which made it the worst blocker in the
 * system: a claim is permanent, a single public IPv4 can front thousands of
 * mobile subscribers, and this check runs *before* D1 ever sees the insert — so
 * relaxing the database constraint alone would not have unblocked anyone. See
 * docs/vote-integrity.md.
 *
 * This is the fast, globally-consistent FIRST gate, not the source of truth —
 * the UNIQUE index on voter_id in packages/db/src/schema.ts remains that. A DO
 * instance is pinned to one location and serializes its own calls, so two
 * concurrent requests from one voter cannot both slip through here the way they
 * theoretically could between two racing D1 reads — but the D1 constraint is
 * still what recordVote() falls back on, so this DO being briefly unavailable
 * degrades to "D1 catches it instead", not "the dedup breaks".
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

  /**
   * Gives the claim back, for the case where the caller claimed successfully and
   * then failed to record the vote.
   *
   * Without this a transient D1 failure is unrecoverable for that voter: the
   * claim is spent, no row exists, and every retry is refused by a gate guarding
   * a vote that was never cast. The claim is only meaningful once a row exists,
   * so releasing it on the write failing is what keeps the two consistent.
   */
  async release(): Promise<void> {
    await this.ctx.storage.delete("claimed");
  }
}
