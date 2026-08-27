# Capacity — what a vote costs, and where the ceiling is

Every figure here was measured against the running system: query plans via `EXPLAIN QUERY PLAN`,
index counts via `pragma_index_list`, bindings via `wrangler deploy --dry-run`. Where a number is an
estimate rather than a measurement, it says so.

The *why* behind the read and write costs lives in [vote-integrity.md](./vote-integrity.md). This
page is the budget view: how many votes per day, which resource runs out first, and what to do about
it.

## What one vote costs

| Resource | Cost | Notes |
| --- | --- | --- |
| Worker requests | **2** | `GET /` and `POST /api/vote`. The confirmation renders in place, so there is no third request for `/thanks`. |
| D1 rows written | **3** | 1 row + 1 index entry (`idx_votes_voter_id`) + 1 tally update. |
| D1 rows read | **~0** | A first-time voter costs zero — a brand-new `voter_id` cannot have a row, so the lookup is skipped. |
| Durable Object requests | **1** | Rate limiter only. |

Static assets — CSS, favicon — are **free and unlimited** and never count. Candidate images are on
jsDelivr and never touch the Worker at all.

## Free-tier ceilings

| Resource | Free/day | Votes/day |
| --- | --- | --- |
| **Worker requests** | 100,000 | **~28,000–50,000** ← binds first |
| D1 rows written | 100,000 | ~33,000 |
| Durable Object requests | 100,000 | ~100,000 |
| D1 rows read | 5,000,000 | not binding |

The Worker range depends on how many voters also open `/results`, which costs one page render plus
roughly `visit_duration ÷ TTL` polls — about 0.5 for a five-minute visit at the production TTL. If
nobody checks results a vote is 2 requests; if everyone does it is nearer 3.5.

**Realistically ~25,000–30,000 votes/day**, since abandoned visits and bot traffic consume requests
without producing votes.

Two behaviours worth knowing:

- **Quotas reset at midnight UTC, and exceeding one returns errors** rather than degrading. For a
  vote that means people simply cannot vote for the remainder of the UTC day.
- **Cron trigger invocations count against the same daily request cap.** There is no separate
  allowance for scheduled work.

## Paid tier

The $5/month Workers Paid plan includes 10 million requests. A 500,000-vote event needs roughly
1.5M — about 15% of the allowance.

The one line to watch is **Durable Objects: 1 million requests/month included**. At 1 request per
vote, a 500k event sits exactly at the boundary and tips slightly into overage at $0.15/million.
Pennies, but it is the first thing to exceed its included amount.

D1's 50M writes and 25 billion reads per month are not close to binding at this scale.

## If you need more headroom on free tier

In rough order of leverage:

1. **Reduce `/results` cost.** The page render is one Worker request per visit and is the largest
   remaining per-vote-adjacent cost. Polling is already bounded by an idle pause.
2. **Reduce writes below 3.** The floor for the current design: one row, one index entry for the
   `voter_id` UNIQUE constraint that *is* the dedup mechanism, and one tally update. Going lower
   means giving up one of those.
3. **Move the tally to a Durable Object.** D1 writes would drop to 2/vote (~50,000/day) and DO
   writes would rise to 2/vote (~50,000/day), balancing the two. Costs a single-threaded object per
   candidate and a more complex read path — worth it only if D1 writes are demonstrably the binding
   constraint.

## What is *not* a lever

**A cron job.** It was evaluated and rejected. Every user-facing request is a Worker invocation
regardless of how the data behind it was computed, so a scheduled job cannot reduce the binding
constraint — and its own invocations count against the same cap. It would also introduce a job that
can fail silently and freeze published results.

## The limit is per day, not per event

This matters more than the raw ceiling. Cloudflare's allowances are **daily and reset at 00:00 UTC**,
so sustained moderate load is free indefinitely — ~30,000 votes/day is roughly **900,000 a month**
without paying anything. What the free tier cannot absorb is *compression*: the same total votes
arriving in a few days rather than spread out.

That distinction is the whole lesson from the predecessor. It processed 400,000 votes in **five
days** — about 80,000/day — and the surge exhausted a monthly quota whose only failure mode was
suspending the account. The same 400,000 votes over a month would sit comfortably inside this
system's free tier.

So when estimating, ask "how many votes on the busiest day", not "how many votes total". See the
predecessor's [postmortem](https://github.com/Madiocre/vote-system/blob/main/POSTMORTEM.md) for what
failed and why.
