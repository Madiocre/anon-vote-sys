# anon-vote-sys

Anonymous public voting on Cloudflare Workers — one Astro app with Hono mounted underneath it,
D1 for storage, and two Durable Objects (a one-shot vote gate and a rate limiter).

Architecture decisions and their reasoning live in `../CLAUDE.md`. Read the relevant section
before changing anything it covers.

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
| `bun run typecheck` | Typechecks all three workspaces |
| `cd apps/web && bun run dev` | Astro dev server |
| `cd apps/web && bun run build` | Production build |
| `cd apps/web && bun run generate-types` | Regenerates `worker-configuration.d.ts` — rerun after every `wrangler.jsonc` edit |
| `cd packages/db && bun run generate` | Generates a migration from `src/schema.ts` |
| `cd packages/db && bun run migrate:local` | Applies pending migrations to local D1 |
| `cd packages/db && bun run seed:local` | Upserts `seed/candidates.json` (idempotent) |
| `cd packages/db && bun run reset:local` | Clears the votes table locally, keeps candidates |

## Status

Phases 1–3 complete: schema, migrations, seeds and `packages/shared` are done, and the Worker
entrypoint registers both Durable Objects. The Hono app in `apps/web/src/server/` is written but
not yet mounted — there is no `src/pages/api/[...route].ts`, so `/api/*` is unreachable. That is
phase 4. See §8 of `../CLAUDE.md`.
