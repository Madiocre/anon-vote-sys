# Testing

```bash
bun test
```

```bash
bun run check
```

`check` is `typecheck && test` — the same gate CI runs.

## How server tests run outside workerd

The whole server suite runs in plain Bun, with no workerd and no miniflare. That works because
**nothing in `src/server` imports a Durable Object class at runtime** — `env.ts` pulls in
`RateLimiter` with `import type`, which `verbatimModuleSyntax` erases. So the Hono app and every
lib module load normally, and only the *bindings* need faking.

Hono helps here too: `app.fetch(request, env, ctx)` is the real entry point, so a test can drive the
actual routing, middleware chain and handlers with a stub `env` and get a real `Response` back.

## What is covered

87 tests across six files.

| File | Covers |
| --- | --- |
| `lib/crypto.test.ts` | HMAC sign/verify round-trip, tampered payload and signature, wrong secret, malformed tokens, a known SHA-256 vector, non-ASCII payloads |
| `lib/identity.test.ts` | Cookie parsing (including the prefix trap — `myvid` must not answer a lookup for `vid`), client-IP header precedence, salted hash determinism, the no-IP fallback, and every `getVoterStatus` branch |
| `lib/turnstile.test.ts` | Request shape sent to siteverify, `remoteip` inclusion, and that it **fails closed** on a non-OK response or a body with no `success` |
| `env.test.ts` | `resultsTtl` fallbacks (empty, non-numeric, zero, negative) and `requireSecret` rejecting empty strings |
| `middleware/rate-limit.test.ts` | Both layers, the edge short-circuit (a rejected edge check must not pay for a DO round trip), and per-route and per-identity key isolation |
| `index.test.ts` | Every route, both vote paths, error handling, and that rate limiting is actually attached |

The parts worth knowing are covered on purpose:

- **The no-JavaScript form path.** A form POST must get a 303 to `/thanks`, not JSON — and error
  cases must redirect to `/?error=…`, which is what `index.astro` reads. This is easy to break and
  invisible in a browser with JS on.
- **The token field name.** Turnstile's implicit rendering injects `cf-turnstile-response`; the
  markup never names it. If that string drifts, every no-JS vote silently fails verification.
- **Ordering: Turnstile is checked before the DO gate.** A request already doomed by a failed
  challenge must not claim the gate — a claim cannot be deleted, so it would lock that voter out
  permanently. There is a test asserting the gate stays unclaimed on a failed challenge.
- **Failing closed.** A Turnstile outage returns `false`, not a free pass.
- **`app.onError`.** A thrown D1 error and a missing secret both come back as `server_error` JSON,
  not Hono's plain-text 500 that the ballot's fetch handler cannot parse.

## What is NOT covered, and why

- **Real D1 SQL.** The tests mock the `@avs/db` boundary, so the Drizzle query builder, the `LEFT
  JOIN`, the `ON CONFLICT` behaviour and the UNIQUE indexes are not exercised. Those need a real
  database.
- **Durable Object storage.** `RateLimiter` is stubbed with equivalent behaviour, not run. Their persistence, single-threading and per-colo identity are workerd properties.
- **The Workers Cache API.** `caches` is undefined in Bun, so `lib/cache.ts` takes its in-memory
  fallback — the same path `astro dev` uses. Real per-colo edge caching is untested.
- **`.astro` files.** Not typechecked at all (TypeScript 7 blocks `astro check`); `astro build` is
  the only gate.

Closing the first three means adding `@cloudflare/vitest-pool-workers`, which runs tests inside
workerd with real bindings. Worth doing before the schema changes again; not worth it for the
request logic already covered here.

## The second phase: smoke tests against a live deployment

`scripts/smoke.ts` covers what the unit tests structurally cannot, by talking to a real deployment:

```bash
bun run smoke https://anon-vote-sys-staging.<subdomain>.workers.dev
```

It checks `/api/health`, `/api/candidates` (which proves the D1 binding resolves *and* the table
exists *and* it was seeded — three separate ways a deploy looks fine and is useless), `/api/results`,
`/api/status` (which needs `COOKIE_SECRET` to be set), and that both pages render.

It is **read-only** and never casts a vote, so CI never adds rows to a real tally.

One assertion is a specific regression guard — the ballot must contain **exactly one** Turnstile
widget. The widget was originally rendered inside each `CandidateCard`, so a twenty-candidate ballot
shipped twenty challenge widgets. That is invisible to unit tests and to a build, and only obvious
when you look at the deployed page.

The pipeline runs this against staging before production is reachable at all — see
[ci-pipeline.md](./ci-pipeline.md).

## Two constraints that shape the test code

**`mock.module` is process-global.** `bun test` runs every file in one process, and `mock.module`
registers against that process's module registry — not per file. Two files each registering their
own partial `@avs/db` mock would race, and whichever ran last would win. That is why there is exactly
one registration, in `src/server/db-mock.ts`, with shared mutable state and a `resetDbState()` called
from `beforeEach`.

**The results cache is module-level.** `lib/cache.ts` holds its fallback `Map` in module scope, so
cached candidates and results persist across tests *and* across files. The suite works around this by
using one stable dataset (`CANDIDATES` in `db-mock.ts`) everywhere, rather than varying the ballot
between tests. If you need a genuinely different list, use a route that supports cache bypass
(`/api/results?fresh=1`) or assert on something other than the cached read.

## Adding tests

Put `*.test.ts` next to the code it covers. They are excluded from `tsconfig.json` and typechecked by
`tsconfig.test.json` instead — that split exists so `types: ["bun"]` can be on for tests without
leaking Bun globals into Worker source, where they do not exist at runtime. `bun run typecheck` runs
both configs, so neither half is skipped.

Test files are never bundled: nothing in `src/pages` imports them, so the build tree-shakes them out.
Verified by grepping `dist/` after a build.
