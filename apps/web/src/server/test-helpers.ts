/**
 * Shared stubs for the server tests.
 *
 * These run under `bun test`, not workerd, which works because nothing in
 * src/server imports a Durable Object class at runtime — env.ts pulls in
 * `VoteGate`/`RateLimiter` with `import type`, which is erased. So the Hono app
 * and every lib module load in plain Bun, and only the *bindings* need faking.
 *
 * What is NOT covered here, deliberately: real D1, real Durable Object storage,
 * and the Workers Cache API. Those only exist inside workerd — testing them
 * needs @cloudflare/vitest-pool-workers. Everything below is a behavioural
 * stand-in good enough to exercise the request logic.
 */

import type { Env } from "./env.ts";

/** A DO stub that reproduces VoteGate's contract: first claim per id wins. */
export function makeVoteGateNamespace() {
  const claimed = new Set<string>();
  const released: string[] = [];

  return {
    claimed,
    /** Ids whose claim was handed back — the D1-write-failed path. */
    released,
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        claim: async (): Promise<boolean> => {
          if (claimed.has(id.name)) return false;
          claimed.add(id.name);
          return true;
        },
        release: async (): Promise<void> => {
          claimed.delete(id.name);
          released.push(id.name);
        },
      }),
    },
  };
}

/** A DO stub for RateLimiter, counting calls per key against a fixed window. */
export function makeRateLimiterNamespace(options: { allow?: boolean } = {}) {
  const calls: Array<{ key: string; limit: number; windowMs: number }> = [];
  const counts = new Map<string, number>();

  return {
    calls,
    namespace: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        checkLimit: async (limit: number, windowMs: number) => {
          calls.push({ key: id.name, limit, windowMs });
          const next = (counts.get(id.name) ?? 0) + 1;
          counts.set(id.name, next);
          return {
            allowed: options.allow === false ? false : next <= limit,
            remaining: Math.max(0, limit - next),
          };
        },
      }),
    },
  };
}

export interface EnvStub {
  env: Env;
  voteGate: ReturnType<typeof makeVoteGateNamespace>;
  rateLimiter: ReturnType<typeof makeRateLimiterNamespace>;
  edgeCalls: Array<{ key: string }>;
}

/**
 * A complete Env with every binding stubbed. `DB` is an empty object on purpose:
 * the tests mock the `@avs/db` module, so the raw binding is never dereferenced —
 * createDb() only ever wraps it.
 */
export function makeEnv(
  overrides: Partial<Env> = {},
  options: { edgeAllows?: boolean; rateLimiterAllows?: boolean } = {},
): EnvStub {
  const voteGate = makeVoteGateNamespace();
  const rateLimiter = makeRateLimiterNamespace({ allow: options.rateLimiterAllows });
  const edgeCalls: Array<{ key: string }> = [];

  const env = {
    DB: {} as Env["DB"],
    VOTE_GATE: voteGate.namespace as unknown as Env["VOTE_GATE"],
    RATE_LIMITER: rateLimiter.namespace as unknown as Env["RATE_LIMITER"],
    EDGE_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        edgeCalls.push({ key });
        return { success: options.edgeAllows !== false };
      },
    } as unknown as Env["EDGE_RATE_LIMITER"],
    VOTE_SALT: "test-salt",
    COOKIE_SECRET: "test-cookie-secret",
    TURNSTILE_SECRET: "test-turnstile-secret",
    TURNSTILE_SITEKEY: "1x00000000000000000000AA",
    RESULTS_TTL_SECONDS: "600",
    ...overrides,
  } as Env;

  return { env, voteGate, rateLimiter, edgeCalls };
}

/** Builds a Request with the headers the identity layer actually reads. */
export function makeRequest(
  path: string,
  init: RequestInit & { ip?: string; cookies?: Record<string, string> } = {},
): Request {
  const { ip = "203.0.113.7", cookies, ...rest } = init;
  const headers = new Headers(rest.headers);

  if (ip) headers.set("cf-connecting-ip", ip);
  if (cookies && Object.keys(cookies).length > 0) {
    headers.set(
      "cookie",
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("; "),
    );
  }

  return new Request(`https://vote.test${path}`, { ...rest, headers });
}

/** Reads every Set-Cookie off a response into a name -> value map. */
export function readSetCookies(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

/** What a stubbed fetch records. Flattened rather than holding a Request, which
 *  avoids the Cf-generic mismatch between the DOM and workers-types `Request`. */
export interface RecordedRequest {
  url: string;
  method: string;
  body: string;
}

/**
 * Swaps global fetch for the duration of a test. Returns a restore function and
 * the recorded calls — used to assert what was sent to Turnstile's siteverify.
 */
export function stubFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: RecordedRequest[] = [];

  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let method = init?.method ?? "GET";
    let body = "";

    if (input && typeof input === "object" && "text" in input) {
      const request = input as { method?: string; text(): Promise<string> };
      method = request.method ?? method;
      body = await request.text();
    } else if (init?.body !== undefined) {
      body = String(init.body);
    }

    const recorded: RecordedRequest = { url, method, body };
    calls.push(recorded);
    return handler(recorded);
  }) as unknown as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** Turnstile siteverify responder. */
export function turnstileResponder(success: boolean, ok = true) {
  return () =>
    new Response(JSON.stringify({ success }), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
}
