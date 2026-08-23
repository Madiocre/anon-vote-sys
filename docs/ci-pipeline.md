# CI/CD — Cloudflare Workers Builds

Pushes build, gate, and deploy automatically. This replaces the manual sequence in
[deployment.md](./deployment.md), which stays as the first-time setup and recovery path.

We use **Workers Builds** (Cloudflare's own CI) rather than GitHub Actions. Note these are
alternative CI systems, not composable — `oven-sh/setup-bun` and friends are GitHub Actions and have
no meaning here. Workers Builds runs its own Ubuntu 24.04 image with runtimes preinstalled; you pick
versions with **build variables** instead of setup steps.

## The one thing that is genuinely counter-intuitive

**The environment is chosen at build time, not deploy time.**

Normally you select a Wrangler environment with `wrangler deploy --env staging`. That does **not**
work here. The Astro Cloudflare adapter writes a *flattened* config to `dist/server/wrangler.json`
during the build and wrangler deploys against that redirected file — which contains no `env` block at
all. `--env staging` therefore has nothing to select and silently deploys **production bindings**.

Verified: building normally and running `wrangler deploy --env staging --dry-run` reports
`env.DB (anon-vote-sys)` and `RESULTS_TTL_SECONDS ("600")` — production, despite the flag.

The environment is selected by setting `CLOUDFLARE_ENV` before the build, which is what
`bun run deploy:staging` does:

```
CLOUDFLARE_ENV=staging astro build && wrangler deploy
```

With that, the generated config comes out as `anon-vote-sys-staging` / `anon-vote-sys-staging` D1 /
TTL 60 / rate-limit namespace 1002, and a plain `wrangler deploy` does the right thing. Adding
`--env staging` on top is harmless but redundant.

## Dashboard settings

Workers Builds → connect the repo to the **`anon-vote-sys`** Worker, then Settings → Build.

| Setting | Value |
| --- | --- |
| Root directory | `apps/web` |
| Build command | see below |
| Deploy command | `bunx wrangler deploy` |
| Non-production branch deploy command | `bunx wrangler versions upload` |
| Build variables | `BUN_VERSION=1.4.0`, `SKIP_DEPENDENCY_INSTALL=1` |
| Build watch paths — include | `apps/*`, `packages/*` |
| Branch control | production `main`; non-production branch builds **enabled** |

The dashboard Worker name must match `name` in the `wrangler.jsonc` under the root directory, or the
build fails before it starts.

### Build command

```
cd ../.. && bun install --frozen-lockfile && bun run --cwd apps/web types && bun run typecheck && bun run --cwd apps/web build
```

Three parts of that are load-bearing and not obvious:

- **`cd ../..`** — the root directory is `apps/web`, but this is a Bun *workspace* monorepo.
  `bun.lock` and the `workspaces` array live at the repo root, and `@avs/db` / `@avs/shared` resolve
  through `workspace:*`. An install run inside `apps/web` cannot link them.
- **`SKIP_DEPENDENCY_INSTALL=1`** — follows from the above. Cloudflare's automatic install would run
  in the wrong directory, so we turn it off and let the build command own installation.
- **`bun run --cwd apps/web types`** — regenerates `worker-configuration.d.ts`, which is gitignored
  and therefore absent from a fresh clone. Without it the typecheck fails with **19** "cannot find
  name / cannot find module" errors that look like broken imports rather than missing codegen.
  (Verified by deleting the file: 19 errors without it, 0 with.) It reads `wrangler.jsonc` only and
  needs no credentials, so it is safe this early.

Any non-zero exit in that chain fails the build and the deploy command never runs. That is the gate.

### Why `BUN_VERSION` is mandatory

The build image defaults to **Bun 1.2.15**. Our `bun.lock` is `lockfileVersion: 2`, written by Bun
1.4 — an older Bun will not read it cleanly, and `--frozen-lockfile` turns that into a failed build
rather than a silent re-resolve. Pin `1.4.0` to match local.

## Staging vs production

Production and staging are **separate Workers** — a named environment deploys as
`<name>-<env>`, so `anon-vote-sys-staging` has its own D1, its own Durable Object namespaces, and its
own rate limiter.

This is not fussiness. A version/preview build uses the Worker's **top-level bindings**, so a preview
URL on the production Worker talks to the production D1. On a voting app that means a test vote lands
in the live tally *and* burns a `VoteGate` claim, which cannot be deleted. Staging exists so that
cannot happen.

Because the adapter bakes the environment in at build time, deploying staging from CI means changing
the **build** command, not the deploy command. Two ways to wire it:

**Option A — production only from CI (simplest).** Leave non-production branch builds off, or leave
the non-production deploy command as `bunx wrangler versions upload`, understanding that such a
preview runs against production bindings and must not be voted on. Deploy staging by hand with
`bun run deploy:staging`.

**Option B — a second Workers Builds connection.** Connect the repo again, this time to the
`anon-vote-sys-staging` Worker, with root directory `apps/web`, the same build variables plus
`CLOUDFLARE_ENV=staging`, and branch control set so it builds the branches production ignores. Each
Worker then has its own build project and they never collide.

Option B is the real answer if you want branch pushes to land somewhere safe automatically. Start
with A, move to B when branch previews start mattering.

## Where tests plug in later

There is **no test suite yet** — nothing under `bun:test` exists, so today the gate is typecheck plus
build. When you write specs, add `&& bun test` after `bun run typecheck` in the build command.

Good first targets, all pure logic needing no Worker runtime:

- `signToken` / `verifyToken` round-trip — `apps/web/src/server/lib/crypto.ts`
- the percentage maths in `aggregateResults` — `packages/db/src/index.ts`
- `wantsJson` content negotiation — `apps/web/src/server/index.ts`

Anything touching D1 or a Durable Object needs `@cloudflare/vitest-pool-workers` rather than plain
`bun:test`, since those bindings only exist inside workerd.

## Migrations stay manual

Do **not** put `wrangler d1 migrations apply --remote` in the deploy command. This matters more now
that deploys are automatic: SQLite cannot drop or retype a column in place, so drizzle-kit emits a
full table rebuild for those changes. Run unattended against a populated `votes` table, that is
unrecoverable.

Run migrations by hand, staging first:

```bash
cd packages/db && bun run migrate:staging
```

```bash
cd packages/db && bun run migrate:remote
```

## Limits

Free plan: 3,000 build minutes/month, 1 concurrent build, 20-minute timeout, 2 vCPU / 8 GB RAM /
20 GB disk. This build runs in well under a minute, so the cap is not a practical concern. Paid is
6,000 minutes and 6 concurrent builds.

## What you give up versus GitHub Actions

Worth knowing before you hit it: no PR-only checks that gate without deploying, no matrix builds, no
steps *after* deploy (smoke tests, notifications), and the build log is the only artifact. If any of
those become necessary, Actions is the better tool — but for build-gate-deploy, this is far less
machinery to maintain.
