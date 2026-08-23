# CI/CD — GitHub Actions

Two committed workflows. Push, and they run.

| File | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull requests, pushes to any branch except `main` | Gate, then deploy to staging and smoke test it. Never touches production. |
| `.github/workflows/deploy.yml` | pushes to `main`, or manual dispatch | Promotion pipeline: gate → staging → smoke → production. |

## Production is not directly reachable

`deploy.yml` is four jobs chained with `needs`:

```
check  ->  staging  ->  smoke  ->  production
```

Every arrow is a hard dependency, so **there is no path that deploys to production without deploying
to staging and smoke-testing it first.** That is the point: `bun run deploy` straight to production is
an easy habit precisely because it is one line, so the pipeline removes the shortcut rather than
relying on remembering.

If you want a human checkpoint too, the `production` job declares `environment: production` — add a
required reviewer to that environment in repo settings and the job waits for approval before running.

`workflow_dispatch` takes a `staging_only` flag for deploying to staging without promoting.

## The two testing phases

**Phase one, offline:** `bun run check` — typecheck plus 87 unit tests, every binding stubbed. Fast,
runs on forks, catches logic and type regressions.

**Phase two, against a live deployment:** `scripts/smoke.ts`, run against the staging URL that
`wrangler-action` reports as `deployment-url`.

Phase one cannot catch a whole class of failure by construction, because it stubs the bindings: a
missing D1 binding, an unmigrated database, an unset secret, a Worker that fails to boot, an
`imageUrl` that is not a resolvable URL. Phase two hits all of those, since it talks to a real
deployment with real bindings.

It is **read-only** on purpose — it never casts a vote. A vote from the runner would burn a
`VoteGate` claim for the runner's IP, and those cannot be deleted.

It also asserts there is **exactly one** Turnstile widget on the ballot, which is a regression guard
for a real bug: the widget was originally rendered per candidate card, so a twenty-candidate ballot
shipped twenty challenge widgets.

Run it by hand against anything:

```bash
bun run smoke https://anon-vote-sys-staging.<subdomain>.workers.dev
```

## Why Actions rather than Cloudflare's own Workers Builds

Workers Builds works, and needs no API token. But its entire configuration — build command, deploy
command, build variables, watch paths — lives in the **Cloudflare dashboard**, not in the repository.
There is no file to commit. That is not a convention you can opt out of: there is [no API for
enabling the Git integration](https://github.com/cloudflare/workers-sdk/issues/12058), and the
[Terraform provider cannot do it either](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6924)
— it must be clicked through by hand.

So the pipeline could not be version-controlled, reviewed in a PR, or rebuilt from the repo. For a
project where the deploy gate is the only thing standing between a bad commit and a live vote, having
that gate be unversioned dashboard state is the wrong trade. Everything here is in git instead.

Workers Builds also has an account-wide limit of **1 concurrent build** on the free plan (6 on paid),
shared across every Worker. GitHub-hosted runners give 20 concurrent jobs on the free tier.

## One-time setup

**1. Create the two repository secrets.** Settings → Secrets and variables → Actions:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview, right-hand sidebar |

**2. Scope the API token.** Use a custom token with:

| Permission | Why |
| --- | --- |
| Account → Workers Scripts → Edit | Publishing the Worker |
| Account → Workers KV Storage → Edit | The Astro adapter auto-provisions the `SESSION` KV namespace on deploy |
| Account → Account Settings → Read | Account lookups during deploy |

**Not** D1 Edit — migrations are deliberately not run from CI (see below), so the token does not need
write access to the vote database. That is the point of leaving them out.

**3. Create the D1 databases by hand**, before the first deploy. CI will not create them, and
`database_id` in `wrangler.jsonc` must already be real:

```bash
wrangler d1 create anon-vote-sys
```

> **Blocker: the staging database does not exist yet.** `env.staging.d1_databases[0].database_id` in
> `apps/web/wrangler.jsonc` is still the literal placeholder `TODO-CREATE-STAGING-D1`. Because every
> path to production now runs through staging, **the entire pipeline fails until this is done**:
>
> ```bash
> wrangler d1 create anon-vote-sys-staging
> ```
>
> Paste the returned id into that field, then migrate and seed it:
>
> ```bash
> cd packages/db && bun run migrate:staging && bun run seed:staging
> ```
>
> Staging also needs its own three secrets — they do not inherit from production:
> `wrangler secret put VOTE_SALT --env staging`, and likewise `COOKIE_SECRET` and
> `TURNSTILE_SECRET` (use the always-passes test secret for staging).

**4. Set the three secrets on the Worker**, after the first successful deploy has created it:

```bash
cd apps/web && bun x wrangler secret put VOTE_SALT
```

…and `COOKIE_SECRET`, `TURNSTILE_SECRET`. These are Cloudflare secrets, not GitHub secrets — see
[deployment.md](./deployment.md).

That is the whole setup. From then on, pushing to `main` deploys.

## The steps, and the two that are not obvious

Both workflows run the same chain:

```
bun install --frozen-lockfile
bun run --cwd apps/web types
bun run check
bun run --cwd apps/web build
```

**`bun run --cwd apps/web types` is required.** `worker-configuration.d.ts` is gitignored, so a fresh
clone has no declarations for `D1Database`, `DurableObjectNamespace`, `RateLimit`, `ExecutionContext`
or the `cloudflare:workers` module. Without it the typecheck fails with 19 "cannot find name/module"
errors that read like broken imports rather than missing codegen. Verified by deleting the file: 19
errors without, 0 with. It reads `wrangler.jsonc` only and needs no credentials, so it runs before
any secret is in play.

**The environment is chosen at build time, not deploy time.** The Astro adapter flattens
`wrangler.jsonc` into `dist/server/wrangler.json` during the build, and that generated file has no
`env` block. So `wrangler deploy --env staging` finds nothing to select and silently ships
**production** bindings. Verified: with a normal build, `wrangler deploy --env staging --dry-run`
reports `env.DB (anon-vote-sys)` and `RESULTS_TTL_SECONDS ("600")` despite the flag.

`build:staging` sets `CLOUDFLARE_ENV=staging`, which is what actually resolves the environment. After
that a plain `wrangler deploy` is correct — which is why the deploy step passes `command: deploy` in
both cases and the *build* step is the one that branches.

## Deploying to staging

Actions tab → Deploy → Run workflow → target `staging`. It builds with `CLOUDFLARE_ENV=staging` and
deploys to the `anon-vote-sys-staging` Worker, which has its own D1, its own Durable Object
namespaces and its own rate limiter — so a test vote there cannot reach the live tally.

## The gate

`bun run check` is `typecheck && test`: three workspaces typechecked across both tsconfigs, plus 87
server tests. Then `build`, which is the only thing that checks `.astro` files at all — `astro check`
cannot run against TypeScript 7.

See [testing.md](./testing.md) for what the tests cover and, more importantly, what they do not:
real D1 SQL, Durable Object persistence and the Workers Cache API are stubbed, because they only
exist inside workerd.

## Migrations are deliberately not automated

Never add `wrangler d1 migrations apply --remote` to the deploy workflow. SQLite cannot drop or
retype a column in place, so drizzle-kit emits a full table rebuild for those changes. Run unattended
against a populated `votes` table, that is unrecoverable.

Run them by hand, staging first:

```bash
cd packages/db && bun run migrate:staging
```

```bash
cd packages/db && bun run migrate:remote
```

The API token is scoped without D1 write access specifically so CI *cannot* do this by accident.

## App secrets stay out of GitHub

`VOTE_SALT`, `COOKIE_SECRET` and `TURNSTILE_SECRET` are set once with `wrangler secret put` and live
in Cloudflare. `wrangler-action` has a `secrets` input that would push them on every deploy, but
using it means a second copy of your cookie-signing key and IP-hash salt sitting in GitHub — for no
gain, since they do not change between deploys.

`TURNSTILE_SITEKEY` is public and already committed in `wrangler.jsonc`. It is not a secret.
