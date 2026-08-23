# AGENTS.md — apps/web

**The architecture document for this project lives one level above the repo root, at
`VoteSystemsAttempts/CLAUDE.md`.** Read it before changing anything under `src/server/`,
`wrangler.jsonc`, or `astro.config.mjs`.

Source comments in this app cite it by section — "AGENTS.md §0", "§5" and so on. Those refer to
that file, not to this one. Quick index:

| § | Covers |
|---|---|
| §0 | Vote-flow decisions: DO gate keyed on `ip_hash`, Turnstile via implicit rendering |
| §1 | Workspace layout — why `src/server/` is not a workspace package |
| §2 | Durable Object registration: `output: "server"`, `src/worker.ts`, `main`, `exports` |
| §3 | Results caching — Cache API read-through, `RESULTS_TTL_SECONDS=600` |
| §4 | Schema shape, Drizzle, migrations wiring, images-as-plain-URLs |
| §5 | Rate limiting — the three layers and why a DO is needed alongside the native binding |
| §6 | File-by-file copy/port/drop table |
| §7 | Env, secrets and bindings checklist |
| §8 | Order of operations and current progress |

## Development

Dev server (background mode):

```
astro dev --background
```

Manage it with `astro dev stop`, `astro dev status`, `astro dev logs`.

Local secrets go in `.dev.vars` — copy `.dev.vars.example` and fill it in, or the first request
throws from `requireSecret()`. The public `TURNSTILE_SITEKEY` is a `var` in `wrangler.jsonc`, not
a secret.

Regenerate `worker-configuration.d.ts` after every `wrangler.jsonc` change:

```
bun run generate-types
```

## Astro documentation

- [Routing, dynamic routes, middleware](https://docs.astro.build/en/guides/routing/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Styling](https://docs.astro.build/en/guides/styling/)
- [On-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/)
