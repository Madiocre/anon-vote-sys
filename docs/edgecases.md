# Edge cases

Niche situations with non-obvious consequences. Mostly things that are unlikely but destructive, so
they are worth reading *before* you need them rather than after.

## Adding a candidate

The straightforward one, and your assumption is right with one correction: **no migration is
involved.**

Migrations change the schema (the shape of the tables). Candidates are *rows*. Adding one is a seed,
not a migration:

1. Add the entry to `packages/db/seed/candidates.json`.
2. Publish the image and reference it by a new tag (see [images.md](./images.md)).
3. `cd packages/db && bun run seed:remote`.

No deploy either. The ballot reads candidates from D1 through a cache that expires within
`RESULTS_TTL_SECONDS` (600s in production), so the new card appears within ten minutes at most.

The seed is an `INSERT … ON CONFLICT(id) DO UPDATE`, so re-running it is safe: existing candidates
have their name, image and sort order refreshed, `created_at` is left alone, and existing votes are
untouched.

Mid-election fairness is the real consideration, not the mechanics — a candidate added on day three
has had three fewer days of exposure. That is a decision about the poll, not a technical constraint.

## Removing a candidate — read this first

Unlikely, as you say. Also the most destructive operation in the system, in a way the code does not
warn you about.

### What actually happens

`votes.candidate_id` is declared `references(() => candidates.id, { onDelete: "cascade" })`. So
deleting a candidate row **deletes every vote cast for them**, silently, as part of the same
statement. There is no confirmation and no soft-delete.

That cascade then propagates:

- **The tally goes stale.** `candidates.vote_count` is maintained by `recordVote()`, and a cascade
  delete does not decrement it. The deleted candidate's row goes with it, so their count disappears
  cleanly — but if you delete vote rows any other way, re-zero and recount. See
  [vote-integrity.md](./vote-integrity.md).
- **`totalVotes` drops.** Percentages are computed as `votes / totalVotes` in `aggregateResults`, so
  *every remaining candidate's percentage silently increases.* Nobody gained votes; the denominator
  shrank. If anyone screenshotted the results page beforehand, the numbers will not reconcile.
- **The voters are not released.** Their `votes` row is gone, so the UNIQUE index on `voter_id` no
  longer blocks them — but their signed `vote` cookie still decodes to the deleted candidate's id,
  and `getVoterStatus` answers from that cookie without ever consulting D1.

  So those voters are stuck: redirected to `/thanks`, unable to re-vote, and `/thanks` cannot even
  name who they voted for because the candidate is no longer in the cached list — they get the
  generic "Your vote has been recorded" instead. Their vote is gone and they cannot cast another.

  This used to be genuinely permanent, because a `VoteGate` Durable Object also held an undeletable
  claim. That class has been removed, so the lockout now lives entirely in the cookie — which means
  clearing cookies frees them. Recoverable, but only if they think to try.

### `--prune` is the loaded gun

`seed.ts` has a `--prune` flag that deletes candidates no longer present in the JSON:

```
DELETE FROM candidates WHERE id NOT IN (...)
```

Combined with the cascade above, **removing a line from `candidates.json` and running
`seed:remote --prune` destroys those votes with no prompt.** It is off by default for exactly this
reason. Do not add it to a script or a CI step.

Note that removing a candidate from the JSON *without* `--prune` does nothing at all — the row stays
in D1 and the candidate keeps appearing on the ballot. That is the safe default, but it does mean
"I removed them from the file" is not the same as "they are off the ballot".

### What to do instead

If someone must come off the ballot mid-poll, **do not delete the row.** Options, roughly in order
of preference:

1. **Leave the data, hide the card.** The cleanest fix needs a schema change — an `active` /
   `withdrawn` boolean on `candidates`, with `listCandidates` filtering on it and `aggregateResults`
   still counting the votes. Votes are preserved, history reconciles, and nobody gets locked out.
   This is the only option that is actually correct; the rest are damage control.
2. **Reassign, never delete.** If the poll must continue without them, move their votes to a
   tombstone candidate (`UPDATE votes SET candidate_id = 'withdrawn' WHERE candidate_id = '…'`)
   before removing the original. Totals stay honest and no voter is orphaned.
3. **Accept it and restart the poll.** If the result is already compromised, a clean restart — wipe
   `votes` *and* zero `vote_count` (see [deployment.md](./deployment.md)) — is more defensible than
   publishing numbers that quietly changed.

Whatever you choose, **export first**:

```bash
wrangler d1 execute anon-vote-sys --remote --command "SELECT * FROM votes;" --json > votes-backup.json
```

## Renaming or re-slugging a candidate

`id` is the primary key and the foreign key target. Changing an `id` in `candidates.json` does not
rename anyone — the seed's `ON CONFLICT(id)` sees an id it has never met, so you get a **new**
candidate, and the old one stays with all its votes.

To change a display name, change `name` and leave `id` alone. Treat ids as permanent from the moment
the poll opens.

## A voter clears their cookies

**They can vote again.** This is the accepted cost of dropping IP enforcement, not an oversight.

Identity is the `vid` cookie alone: `getVoterStatus` reads the signed vote cookie, and on a miss
looks up `voter_id` in D1. Clear the cookies and you are a new voter with a new uuid, so nothing
matches. It used to also match on `ip_hash`, which is exactly what locked out second devices on a
shared network.

Partial clears behave differently and better: someone who loses only the `vote` cookie but keeps
`vid` is still recognised via the D1 lookup, and lands on `/thanks`.

See [vote-integrity.md](./vote-integrity.md) for why no amount of tuning recovers this without an
identity layer, and why detection after the fact is the defence instead.

## Two people behind one IP

**Both can vote.** This was the bug that prompted the whole dedup rework — a phone on the same wifi as
an already-voted laptop was refused, because `ip_hash` carried a UNIQUE index and `findExistingVote`
matched on it.

Carrier-grade NAT puts hundreds to thousands of mobile subscribers behind one public IPv4, so at
country scale that rejected real voters in large numbers. `ip_hash` is still recorded, but purely as a
forensic signal — nothing reads it on the request path.

## Local dev has no IP

`computeIpHash` falls back to hashing the *voter id* when no client IP resolves, which is the case
over localhost. This matters much less than it used to, now that `ip_hash` is not an enforcement key —
it only keeps the forensic column meaningful rather than constant. Local dedup is cookie-based, same
as production.

## The results page shows stale numbers

By design. `/api/results` is a read-through cache with a 600s TTL, and a vote deliberately does not
purge it. The page's "Updated X ago / Next refresh in Y min" line is driven by the payload's own
`staleAt`, so it tells the truth about what it is showing.

`?fresh=1` bypasses the cache if you need to confirm a number. It is not linked from the UI.

## A rate-limited voter

`/api/vote` allows 5 attempts per minute **per voter**, `/api/status` 30. The budget is keyed on
`voter_id`, not `ip_hash` — keyed on IP, six people voting in the same minute from one carrier gateway
started returning 429 to legitimate voters.

Exceeding it returns a `429` carrying a `rate_limited` JSON body, so the ballot shows "Too many
attempts in a short time. Wait a moment and try again." It used to be bare text, which the fetch
handler could not parse, so a rate-limited voter was told their vote "could not be recorded" and to
try again — the one action guaranteed not to work.

A separate, much higher per-IP ceiling (300/min) still sits at the edge as a flood guard.
