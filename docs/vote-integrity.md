# Vote integrity — what stops duplicate votes, and what it costs

A decision record. The short version: at country scale with anonymity as a hard
requirement, **IP cannot be an enforcement key**, and no amount of tuning fixes that.
What remains is a cookie, a bot check, and after-the-fact detection.

Target: **~500,000 votes over one week, nationwide.** Every number below follows from that.

## The constraints

1. **Anonymity is the objective.** No accounts, no OAuth, no email. This is settled and it is
   what makes everything else hard — every strong dedup mechanism is an identity mechanism.
2. **Multiple people on one network must be able to vote.** A household, an office, a campus.
3. **One person should not be able to vote many times.**

2 and 3 are in direct tension, and IP was what bought 3.

## What went wrong

A phone on the same wifi as an already-voted laptop was refused, and shown "we don't see a vote
from this browser" — a page that contradicted the refusal. Two distinct problems:

**The refusal itself was by design.** `idx_votes_ip_hash` is a UNIQUE index and `findExistingVote`
matches on `ip_hash`, so a second device behind one public address is a duplicate. `computeIpHash`
hashes `ip:<salt>:<address>` and does **not** mix in the voter id when an address is present, so
two devices on one network produce a byte-identical hash.

**The contradictory message is a separate bug.** `index.astro` decides using *cookie or IP*, while
`thanks.astro` reports using `readVotedCandidateId`, which is **cookie-only** (deliberately, to keep
that page at zero D1 reads). Anyone blocked by IP therefore lands on a page that cannot see their
vote. This is worth fixing regardless of the dedup policy, because it also hits any voter who
clears cookies. **Still outstanding.**

## Why quota-per-IP was rejected

The obvious middle ground — allow up to N votes per IP instead of exactly one — does not survive
the arithmetic.

500,000 ÷ 7 days ≈ 71,000/day. Traffic is not flat; if a peak hour carries ~20% of a day, that is
~14,000 votes in an hour, ~240 per minute nationally.

The denominator is the problem. Carrier-grade NAT commonly puts **hundreds to thousands** of mobile
subscribers behind one public IPv4. "Votes per address" is therefore not a household number.

| N | A farmer gets | Legitimate voters blocked |
| --- | --- | --- |
| 10 | 10 votes | Large numbers of mobile voters |
| 100 | 100 votes | Still blocks the busiest carrier addresses |
| 1,000 | 1,000 votes (0.2% of the poll) | Few — but nothing is being protected any more |

There is no N that is simultaneously a meaningful cap for a home router with four people and a safe
floor for a NAT gateway with four thousand.

**IPv6 makes it worse, not better.** Mobile networks increasingly assign per-subscriber IPv6, so
those users get distinct addresses while IPv4-CGNAT users pile onto shared ones. The same quota
would be near-unique for one half of the electorate and near-useless for the other — two different
rules applied by accident of network stack.

Chosen failure mode: **some people vote more than once**, rather than **some people cannot vote at
all**. For a public poll, turnout is the point, and a silent false block is far harder to detect
than an anomalous vote pattern.

## Why user-agent was rejected

Fails in both directions at once. It is trivially changed via devtools or an extension — and worse,
someone using a UA-switching extension as a privacy tool gets a *different* identity, so it hands
extra votes to exactly the users most likely to defeat it. Meanwhile two identical phones on one
wifi still collide. A dedup key that rewards evasion and punishes ordinary users is not worth
building.

## What actually holds the line now

| Layer | What it stops | What it does not |
| --- | --- | --- |
| `vid` cookie + `idx_votes_voter_id` UNIQUE | Casual repeat voting | A private window, or clearing cookies |
| Turnstile | Automation | A human clicking through repeatedly |
| Per-voter rate limit | Rapid-fire scripted voting | Slow, patient farming |
| `ip_hash` stored, **not enforced** | Nothing at request time | — it is a forensic signal only |

**The honest summary:** a motivated individual can cast on the order of dozens of votes. What the
system can do is make each one manual, bound the rate, and make the pattern visible afterwards.
Anything stronger needs the identity layer that has been ruled out.

## Detection instead of prevention

Since `ip_hash` is still recorded, it becomes the primary forensic signal. After the fact, an
`ip_hash` with thousands of votes is either a carrier gateway or a farm, and the two are
distinguishable by the shape of the data:

- **A carrier gateway** spreads across candidates roughly like the population, and across time like
  ordinary traffic.
- **A farm** concentrates on one candidate, and clusters in time.

Discounting anomalies post hoc is how anonymous polls at scale actually defend themselves. It
requires no identity and does not risk turning away real voters.

If `ip_hash` is kept for this, **normalise IPv6 to the /64 prefix before hashing**. Privacy
extensions rotate the low 64 bits, so hashing the full address gives one phone a fresh identity
every few hours and makes the forensic record useless. *(Not yet implemented — `computeIpHash`
currently hashes the address as received.)*

## Changes made

**Rate limiters rekeyed off IP** — `src/server/middleware/rate-limit.ts`. This was urgent and
independent of the dedup question: it denies service under real traffic.

Layer 2 (the Durable Object budget) now keys on **`voter_id`**, not `ip_hash`. Previously, at 5
requests per minute per IP, one carrier egress address only needed six people voting in the same
minute to start returning 429 — and the ballot renders a 429 as "Your vote could not be recorded",
because it carries no JSON body. Retrying does not help. The affected population is the mobile
majority.

It also fixes a throughput ceiling: a Durable Object is **single-threaded**, so one instance per
carrier IP meant thousands of requests serialising through one object at peak. A uuid key spreads
that across as many instances as there are voters.

Requests with no `vid` cookie fall back to IP keying — otherwise every request would mint a fresh
voter id and the budget would be meaningless. Cookie-less traffic is already anomalous, so that is
the right place to accept sharing.

Layer 1 (the native edge binding) stays keyed on IP as a pure flood guard, raised from **20/min to
300/min** per address per route. 20 was below plausible legitimate load from a single CGNAT address;
300 is far above it while still stopping a flood.

**Dedup no longer touches IP anywhere on the request path.** All three enforcement points were
changed together, because any one of them left alone would have kept the block in place:

| Was | Now |
| --- | --- |
| `uniqueIndex("idx_votes_ip_hash")` | plain `index(...)` — kept for forensic grouping only |
| `findExistingVote(db, voterId, ipHash)` matched either | `findExistingVote(db, voterId)` — voter id only |
| `VoteGate` DO keyed `idFromName(ip_hash)` | **removed entirely** — see below |

`VoteGate` mattered most. Its claim was permanent, and it ran *before* D1 saw the insert — so
relaxing the database constraint on its own would have changed nothing observable.

It was then removed altogether rather than rekeyed. By the time execution reached it, `getVoterStatus`
had already established D1 held no row for the voter, leaving it one job: the concurrent-double-submit
race. `recordVote`'s `onConflictDoNothing` wins that race atomically and returns the same 409 with the
candidate actually recorded. It duplicated the UNIQUE index at the cost of one DO request and one DO
storage write per vote — half the app's entire Durable Object budget.

Two smaller fixes rode along: `thanks.astro` now falls back to `getVoterStatus` on a cookie miss
instead of contradicting the redirect that sent the visitor there, and a rate-limited request returns
a `rate_limited` JSON body instead of bare text the ballot could not parse.

`getVoterStatus` also got cheaper: a brand-new voter id cannot have a row, so first-time visitors
now cost zero D1 reads. That shortcut previously also required the request to have no resolvable IP,
because the lookup matched `ip_hash` too.

### Verified

At the database level, against a freshly migrated local D1:

```
idx_votes_ip_hash   unique: 0
idx_votes_voter_id  unique: 1
```

Two rows with different `voter_id` and the *same* `ip_hash` both insert. A second row with a repeated
`voter_id` still fails with `UNIQUE constraint failed: votes.voter_id`.

## Still outstanding

| | |
| --- | --- |
| Normalise IPv6 to /64 before hashing | `computeIpHash` hashes the address as received. Privacy extensions rotate the low 64 bits, so one phone gets a fresh `ip_hash` every few hours and the forensic record decays. |
| Build the forensic query | Nothing yet groups votes by `ip_hash` to surface anomalies. The index exists to make it cheap. |

## A drizzle-kit trap, found the hard way

`drizzle-kit` 1.0.0-rc.5 **did not detect the index uniqueness change**. After `uniqueIndex(...)` was
changed to `index(...)`, `bun run generate` reported "No schema changes, nothing to migrate", while
the stored snapshot still carried `"isUnique": true` for `idx_votes_ip_hash`.

Trusting that output would have shipped a schema where the UNIQUE constraint was still live and the
fix silently did nothing.

The migration here was regenerated from scratch instead (safe, since the database was being reset
anyway). **If you change an index's uniqueness again, diff the generated SQL before believing
`generate` — a "nothing to migrate" result is not proof there was nothing to migrate.**
