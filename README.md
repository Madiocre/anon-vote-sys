# anon-vote-sys

Anonymous public voting on Cloudflare Workers — one Astro app with Hono mounted underneath it,
D1 for storage, and two Durable Objects (a one-shot vote gate and a rate limiter).

Architecture decisions and their reasoning live in `../CLAUDE.md`. Read the relevant section
before changing anything it covers.

## Docs

| | |
| --- | --- |
| [docs/deployment.md](docs/deployment.md) | Deploying to Cloudflare — pre-deploy gates, ordered commands, post-deploy checks, and the pre-launch reset |
| [docs/images.md](docs/images.md) | Candidate images via jsDelivr: the public assets repo, why tags and never branches |
| [docs/ci-pipeline.md](docs/ci-pipeline.md) | Cloudflare Workers Builds — build settings, the staging split, and why the environment is chosen at build time |
| [docs/testing.md](docs/testing.md) | What the 87 server tests cover, what they deliberately do not, and how they run outside workerd |
| [docs/vote-integrity.md](docs/vote-integrity.md) | What stops duplicate votes, why IP cannot be an enforcement key at scale, and what is still outstanding |
| [docs/edgecases.md](docs/edgecases.md) | Adding and removing candidates, shared IPs, cleared cookies — the niche cases with destructive consequences |

## Layout

```
apps/web/          Astro pages + the Worker entrypoint; src/server/ holds the Hono app
packages/db/       Drizzle schema, migrations, query functions, seed scripts
packages/shared/   Types and constants shared between pages and server code
```

## Setup

```bash
bun install
```

Copy the local secrets template and fill it in — the server throws on the first request without it:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Create the local D1 tables and load the placeholder candidates:

```bash
cd packages/db && bun run migrate:local && bun run seed:local
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run check` | Typecheck + tests — the same gate CI runs |
| `bun run test` | 87 server tests |
| `bun run typecheck` | Typechecks all three workspaces |
| `cd apps/web && bun run dev` | Astro dev server |
| `cd apps/web && bun run build` | Production build |
| `cd apps/web && bun run types` | Regenerates `worker-configuration.d.ts` — rerun after every `wrangler.jsonc` edit |
| `cd apps/web && bun run deploy` | Builds and deploys the production Worker |
| `cd apps/web && bun run deploy:staging` | Same for `anon-vote-sys-staging` (separate D1 and DOs) |
| `cd packages/db && bun run generate` | Generates a migration from `src/schema.ts` |
| `cd packages/db && bun run migrate:local` | Applies pending migrations to local D1 |
| `cd packages/db && bun run migrate:staging` | Same against the staging D1 |
| `cd packages/db && bun run migrate:remote` | Same against production — run staging first |
| `cd packages/db && bun run seed:local` | Upserts `seed/candidates.json` (idempotent) |
| `cd packages/db && bun run seed:staging` | Same against the staging D1 |
| `cd packages/db && bun run reset:local` | Clears the votes table locally, keeps candidates |

## Status

Feature-complete and running in dev. Schema, migrations and seeds are done; the Hono app is mounted
through `src/pages/api/[...route].ts`; the ballot, results and thank-you pages are in place with
Turnstile wired into every card.

Not yet deployed. Before a first deploy you need a real Turnstile widget, the candidate images
published, and the three secrets set — [docs/deployment.md](docs/deployment.md) walks through it in
order.

Known gaps, both deliberate:

- **`.astro` files are not typechecked.** `astro check` cannot run against TypeScript 7 — its
  language server needs a programmatic API the native compiler does not expose yet. `astro build`
  catches syntax, import and template errors in those files, but not frontmatter type errors.
- **Tests stop at the workerd boundary.** The 87 server tests cover the request logic, but real D1
  SQL, Durable Object persistence and the Workers Cache API are stubbed — covering those needs
  `@cloudflare/vitest-pool-workers`. See [docs/testing.md](docs/testing.md).

A load-balancing script is a planned follow-up.
