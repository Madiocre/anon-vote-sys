# Deploying anon-vote-sys to Cloudflare

What actually ships, in what order, and why the order matters.

Routine deploys are automated by Workers Builds — see [ci-pipeline.md](./ci-pipeline.md). This page
is the first-time setup, the parts CI deliberately does not do (migrations, secrets), and the
recovery path when you need to deploy by hand.

## What gets deployed

One Worker, `anon-vote-sys`, containing everything:

| Piece | What it is |
| --- | --- |
| `src/worker.ts` | The entrypoint. Re-exports both Durable Object classes and delegates HTTP to Astro's handler. |
| Astro pages | `/` (ballot), `/results`, `/thanks` — all server-rendered. |
| Hono app | Everything under `/api/*`, reached through `src/pages/api/[...route].ts`. |
| `VoteGate` DO | One instance per voter `ip_hash`; first claim wins. |
| `RateLimiter` DO | Fixed-window counter, one instance per `(ip_hash, route)`. |
| Static assets | `dist/client` served through the `ASSETS` binding. |

Plus the bindings: `DB` (D1), `EDGE_RATE_LIMITER` (native rate limiting), `SESSION` (KV, auto-provisioned
by the Astro adapter), `IMAGES`, and two vars (`RESULTS_TTL_SECONDS`, `TURNSTILE_SITEKEY`).

---

## Pre-deploy gates

Do all five before touching `wrangler deploy`.

### 1. Create a real Turnstile widget

`wrangler.jsonc` currently ships Cloudflare's **always-passes test sitekey**
(`1x00000000000000000000AA`). Deploying that gives the ballot zero bot protection — the widget
renders and every challenge succeeds, including for scripts.

In the Cloudflare dashboard → Turnstile → add a widget for the production hostname. You get two
values: a **sitekey** (public) and a **secret** (private). They are used in different places:

- sitekey → `vars.TURNSTILE_SITEKEY` in `apps/web/wrangler.jsonc`, committed, rendered into the page
- secret → `wrangler secret put TURNSTILE_SECRET`, never committed

### 2. Publish the candidate images

See [images.md](./images.md). Short version: public assets repo, images committed, repo tagged.

### 3. Point the seed at the real images

Replace the `placehold.co` URLs in `packages/db/seed/candidates.json` with the jsDelivr URLs, and
set the real candidate `id`s, names and `sortOrder` while you are there. Note that `id` is the
primary key — changing an id later creates a *new* candidate rather than renaming one.

### 4. Confirm the D1 database exists

```bash
wrangler d1 list
```

`anon-vote-sys` should be listed, and its id should match `database_id` in `apps/web/wrangler.jsonc`
(`059ed4d2-…`). If it does not exist, `wrangler d1 create anon-vote-sys` and update the id.

### 5. Check the rate-limit namespace id is free

`ratelimits[0].namespace_id` is `"1001"`. It must be unique **per Cloudflare account** — if another
Worker on the same account already uses 1001, both share one limiter and silently rate-limit each
other's traffic. Pick a different integer if so.

---

## Deploy

```bash
wrangler login
```

```bash
cd packages/db && bun run migrate:remote
```

Creates `candidates` and `votes` plus the four indexes in the remote D1. Uses the same
`migrations_pattern` config that makes drizzle-kit's nested output discoverable — see
`apps/web/wrangler.jsonc`.

```bash
cd packages/db && bun run seed:remote
```

Upserts by `id`, so it is safe to re-run: names, images and sort order update, existing votes are
untouched.

```bash
cd apps/web && bun run deploy
```

`astro build && wrangler deploy`. Use this rather than a bare `wrangler deploy`, which would happily
ship a stale `dist/`.

### Then set the three secrets

Run these **after** the first deploy — `wrangler secret put` targets a Worker that already exists.
They take effect immediately; no redeploy needed.

```bash
cd apps/web && bun x wrangler secret put VOTE_SALT
```

```bash
cd apps/web && bun x wrangler secret put COOKIE_SECRET
```

```bash
cd apps/web && bun x wrangler secret put TURNSTILE_SECRET
```

**Two of the three you generate; one you cannot.**

`VOTE_SALT` and `COOKIE_SECRET` are just long unpredictable strings — not key pairs, not hashes of
anything. Generate each separately:

```bash
openssl rand -base64 32
```

`TURNSTILE_SECRET` is **issued by Cloudflare** and must pair with the sitekey rendered into the page.
A random value here cannot work: siteverify would reject every challenge and no vote would ever be
accepted. Take it from the Turnstile widget you created in gate 1.

Production values must differ from the ones in your local `.dev.vars` — that file is local-only and
is never read in production. Until all three are set, every request that needs one fails:
`requireSecret()` throws, `app.onError` catches it, and the client gets a `server_error` JSON 500.

> **`VOTE_SALT` must never be rotated once real voting starts.** It is the input to the `ip_hash`
> (`apps/web/src/server/lib/identity.ts`), so changing it re-hashes every voter into a brand-new
> identity — silently voiding IP-based dedup for everyone who already voted, and orphaning every
> `VoteGate` claim. The one moment it is correct to rotate it is the pre-launch reset below.

---

## Post-deploy verification

```bash
curl https://<worker-url>/api/health
```

Expect `{"ok":true,"ttlSeconds":600}`.

```bash
curl -i https://<worker-url>/api/candidates
```

Run it twice: `x-cache: MISS` then `x-cache: HIT`. A permanent MISS means the Cache API layer is not
working and every request is hitting D1.

```bash
curl https://<worker-url>/api/results
```

All candidates present, `totalVotes: 0`.

Then in a browser:

1. Load `/` — the Turnstile widget should render on every card.
2. Cast a vote — you should land on `/thanks` with the candidate you picked.
3. Revisit `/` — should redirect to `/thanks` (answered from the cookie, no D1 read).
4. Open `/` in a private window — should *also* redirect to `/thanks`, this time via the D1 lookup
   on `ip_hash`. This is the check that proves dedup survives a cleared cookie.

```bash
wrangler d1 execute anon-vote-sys --remote --command "SELECT COUNT(*) FROM votes;"
```

Exactly 1.

---

## Reset before going public

Your smoke-test vote leaves **two** traces, and deleting the obvious one is not enough:

1. A row in `votes` — easy to delete.
2. A permanent claim in the `VoteGate` Durable Object, keyed on your `ip_hash`. There is no
   "delete this DO instance" command, and the claim never expires.

Delete only the D1 row and that DO instance still holds a claim for your IP — you would be locked
out of voting on your own poll, with no way to tell why.

The clean reset is to delete the votes **and** rotate `VOTE_SALT`:

```bash
wrangler d1 execute anon-vote-sys --remote --command "DELETE FROM votes;"
```

```bash
cd apps/web && bun x wrangler secret put VOTE_SALT
```

Because `VoteGate` is addressed by `idFromName(ip_hash)` and `ip_hash` is derived from the salt, a
new salt changes every key — the old claims become unreachable and every voter starts from a fresh
instance. Same reasoning applies to `RateLimiter`, whose keys are also salt-derived.

Do this as the **last** step before opening the poll, and never again afterwards.

---

## Staging

`anon-vote-sys-staging` is a **separate Worker** with its own D1, its own Durable Object namespaces
and its own rate limiter, declared under `env.staging` in `apps/web/wrangler.jsonc`. Test votes there
cannot touch the live tally.

One-time setup:

```bash
wrangler d1 create anon-vote-sys-staging
```

Put the returned id into `env.staging.d1_databases[0].database_id`, replacing
`TODO-CREATE-STAGING-D1`. Then:

```bash
cd packages/db && bun run migrate:staging && bun run seed:staging
```

```bash
cd apps/web && bun run deploy:staging
```

Secrets are **per environment** — the production ones do not carry over:

```bash
cd apps/web && bun x wrangler secret put VOTE_SALT --env staging
```

…and likewise `COOKIE_SECRET` and `TURNSTILE_SECRET`. For staging, `TURNSTILE_SECRET` should be
Cloudflare's always-passes test secret `1x0000000000000000000000000000000AA`, matching the test
sitekey already in the `env.staging` vars. Staging does not need real bot protection, and an
always-passing challenge is what lets you (or a future smoke test) actually cast a vote there.

> **`deploy:staging` is not `deploy --env staging`.** The Astro adapter flattens the config into
> `dist/server/wrangler.json` at build time, and that generated file has no `env` block — so
> `wrangler deploy --env staging` finds nothing to select and ships **production** bindings. The
> environment is chosen at build time via `CLOUDFLARE_ENV`, which is exactly what the
> `deploy:staging` script does. Use the script.

## Rolling out a change later

- **Code or pages** — `cd apps/web && bun run deploy`.
- **Candidate names or photos** — edit `candidates.json`, re-tag the assets repo if the image
  changed, then `cd packages/db && bun run seed:remote`. No deploy needed; the ballot reads
  candidates from D1 through a cache that expires within `RESULTS_TTL_SECONDS` (600s).
- **Schema** — `cd packages/db && bun run generate` to produce a migration, review the SQL, then
  `bun run migrate:remote`. Review it properly: SQLite cannot drop or retype a column in place, so
  drizzle-kit emits a table rebuild, and a rebuild against a live vote table is a data-loss risk.
- **Results TTL** — edit `vars.RESULTS_TTL_SECONDS` in `wrangler.jsonc` and redeploy. The results
  page picks the new value up from the payload automatically.
