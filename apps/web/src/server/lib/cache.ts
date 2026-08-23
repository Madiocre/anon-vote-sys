import { aggregateResults, createDb, listCandidates } from "@avs/db";
import type { Candidate, ResultsPayload } from "@avs/shared";

import { resultsTtl, type Env, type WaitUntil } from "../env.ts";

/**
 * Synthetic origin for cache keys. It is never fetched — the Cache API just needs
 * a well-formed URL to key on. Bump CACHE_VERSION to invalidate every entry after
 * a shape change to the payloads.
 */
const CACHE_ORIGIN = "https://cache.vote.internal";
const CACHE_VERSION = "v1";

/**
 * Fallback for runtimes without the Cache API (plain `astro dev` outside workerd).
 * Per-isolate and short-lived, which is exactly what the Cache API gives us anyway
 * for this workload.
 */
const memoryCache = new Map<string, { body: string; expiresAt: number }>();

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;

  const store = caches as CacheStorage & { default?: Cache };
  if (store.default) return store.default;

  try {
    return await store.open(`vote-${CACHE_VERSION}`);
  } catch {
    return null;
  }
}

function keyFor(name: string): string {
  return `${CACHE_ORIGIN}/${CACHE_VERSION}/${name}`;
}

function schedule(ctx: WaitUntil | undefined, promise: Promise<unknown>): void {
  if (ctx?.waitUntil) ctx.waitUntil(promise);
  else void promise.catch(() => {});
}

/**
 * Read-through cache. On a miss the loader runs and the serialized result is
 * stored with `s-maxage`, which is what drives expiry inside the Cache API.
 *
 * Two things worth knowing about the shape of this:
 *   - The cache is per-colo. Each Cloudflare location reads D1 at most once per
 *     TTL, so D1 sees roughly (number of active colos) reads per window rather
 *     than one read per visitor.
 *   - A vote deliberately does NOT purge this. Results going stale for up to the
 *     TTL is the whole point.
 */
async function readThrough<T>(
  name: string,
  ttlSeconds: number,
  ctx: WaitUntil | undefined,
  load: () => Promise<T>,
  options: { bypass?: boolean } = {},
): Promise<{ value: T; hit: boolean }> {
  const key = keyFor(name);
  const cache = await openCache();

  if (!options.bypass) {
    if (cache) {
      const hit = await cache.match(new Request(key));
      if (hit) return { value: (await hit.json()) as T, hit: true };
    } else {
      const hit = memoryCache.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        return { value: JSON.parse(hit.body) as T, hit: true };
      }
    }
  }

  const value = await load();
  const body = JSON.stringify(value);

  if (cache) {
    const stored = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, s-maxage=${ttlSeconds}`,
      },
    });
    schedule(ctx, cache.put(new Request(key), stored));
  } else {
    memoryCache.set(key, { body, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  return { value, hit: false };
}

export interface CachedResults {
  value: ResultsPayload;
  hit: boolean;
}

export async function getCachedResults(
  env: Env,
  ctx?: WaitUntil,
  options: { bypass?: boolean } = {},
): Promise<CachedResults> {
  const ttl = resultsTtl(env);
  return readThrough<ResultsPayload>(
    "results",
    ttl,
    ctx,
    // createDb() only wraps the binding — no connection is opened — so building
    // it inside the loader keeps it off the cache-hit path entirely.
    () => aggregateResults(createDb(env.DB), ttl),
    options,
  );
}

/**
 * Candidates change only when the seed script runs, so they get the same TTL.
 * This is what keeps the voting page itself off D1 for most requests.
 */
export async function getCachedCandidates(
  env: Env,
  ctx?: WaitUntil,
  options: { bypass?: boolean } = {},
): Promise<{ value: Candidate[]; hit: boolean }> {
  return readThrough<Candidate[]>(
    "candidates",
    resultsTtl(env),
    ctx,
    () => listCandidates(createDb(env.DB)),
    options,
  );
}
