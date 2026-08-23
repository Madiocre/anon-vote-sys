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

- **`totalVotes` drops.** Percentages are computed as `votes / totalVotes` in `aggregateResults`, so
  *every remaining candidate's percentage silently increases.* Nobody gained votes; the denominator
  shrank. If anyone screenshotted the results page beforehand, the numbers will not reconcile.
- **The voters are not released.** This is the part that surprises people. Their `votes` row is
  gone, so the UNIQUE indexes on `voter_id` and `ip_hash` no longer block them — but two other
  things still do:
  - their signed `vote` cookie still decodes to the deleted candidate's id, so `getVoterStatus`
    returns `hasVoted: true` from the cookie without ever consulting D1;
  - their `VoteGate` Durable Object claim is still held, and **a DO claim cannot be deleted**.

  So those voters are locked out permanently: redirected to `/thanks`, unable to re-vote, and
  `/thanks` cannot even name who they voted for because the candidate is no longer in the cached
  list — they get the generic "Your vote has been recorded" instead. Their vote is gone and they
  cannot cast another.

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
   `votes`, rotate `VOTE_SALT` to release every DO claim (see [deployment.md](./deployment.md)) — is
   more defensible than publishing numbers that quietly changed.

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

Handled, and worth knowing why. `getVoterStatus` falls back to a D1 lookup on `ip_hash` when the
cookie is missing, so they are still recognised and redirected to `/thanks`. They will not be told
*who* they voted for — that lives only in the signed cookie they just deleted — so the page shows the
generic acknowledgement.

## Two people behind one IP

They share an `ip_hash`, so **the second person cannot vote.** This is a deliberate trade: the
`ip_hash` UNIQUE index is what stops one person voting repeatedly from private windows, and it cannot
distinguish that from a household, an office, or a phone on carrier-grade NAT.

If the poll's audience is likely to share IPs, this is the constraint to revisit before launch, not
after. Dropping the `idx_votes_ip_hash` unique index and relying on cookies plus Turnstile alone is
the lever — it trades dedup strength for reach.

## Local dev has no IP

`computeIpHash` falls back to hashing the *voter id* when no client IP resolves, which is the case
over localhost. Without that fallback every local request would collapse onto one shared hash and
lock the whole machine out after the first vote. It means local dedup is cookie-based only, so
clearing cookies locally lets you vote again — that is expected, and not what production does.

## The results page shows stale numbers

By design. `/api/results` is a read-through cache with a 600s TTL, and a vote deliberately does not
purge it. The page's "Updated X ago / Next refresh in Y min" line is driven by the payload's own
`staleAt`, so it tells the truth about what it is showing.

`?fresh=1` bypasses the cache if you need to confirm a number. It is not linked from the UI.

## A rate-limited voter

`/api/vote` allows 5 attempts per minute per identity, `/api/status` 30. Exceeding either returns a
plain `429` with no JSON body — the ballot's fetch handler treats a non-OK response without a
parseable body as a generic failure and shows "Your vote could not be recorded. Please try again."

That message is misleading for a rate limit but harmless, since waiting is the correct action
either way. Worth improving if it ever shows up in real usage.
