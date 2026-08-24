/**
 * Post-deploy smoke test. Hits a live deployment and fails loudly if the basics
 * are broken.
 *
 *   bun run scripts/smoke.ts https://anon-vote-sys-staging.<subdomain>.workers.dev
 *
 * This is the second testing phase: `bun test` proves the request logic in
 * isolation with every binding stubbed, which by construction cannot catch a
 * missing D1 binding, an unmigrated database, a missing secret, or a Worker that
 * fails to boot. Those only show up against a real deployment — which is exactly
 * what staging is for.
 *
 * Deliberately read-only: it never casts a vote. A vote would burn a VoteGate
 * claim for the runner's IP, and those cannot be deleted.
 */

const baseUrl = process.argv[2]?.replace(/\/$/, "");

if (!baseUrl) {
  console.error("usage: bun run scripts/smoke.ts <base-url>");
  process.exit(1);
}

interface Check {
  name: string;
  run: () => Promise<string>;
}

/** Throws unless the response is OK, including the body to make failures readable. */
async function get(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(`${path} → HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  return response;
}

const checks: Check[] = [
  {
    name: "GET /api/health",
    run: async () => {
      const body = (await (await get("/api/health")).json()) as {
        ok?: boolean;
        ttlSeconds?: number;
      };
      if (body.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(body)}`);
      if (typeof body.ttlSeconds !== "number") throw new Error("ttlSeconds missing");
      return `ok, ttl=${body.ttlSeconds}s`;
    },
  },
  {
    name: "GET /api/candidates",
    run: async () => {
      // Proves the D1 binding resolves AND the table exists AND it was seeded —
      // three separate ways a deploy can look fine and be useless.
      const response = await get("/api/candidates");
      const body = (await response.json()) as { candidates?: Array<{ id: string; imageUrl: string }> };
      const candidates = body.candidates ?? [];
      if (candidates.length === 0) throw new Error("no candidates — is the database seeded?");

      const broken = candidates.filter((c) => !/^https?:\/\//.test(c.imageUrl));
      if (broken.length > 0) {
        throw new Error(`${broken.length} candidate(s) have a non-absolute imageUrl`);
      }
      return `${candidates.length} candidates, all with absolute image URLs`;
    },
  },
  {
    name: "GET /api/results",
    run: async () => {
      const body = (await (await get("/api/results")).json()) as {
        totalVotes?: number;
        candidates?: unknown[];
        staleAt?: number;
      };
      if (typeof body.totalVotes !== "number") throw new Error("totalVotes missing");
      if (!Array.isArray(body.candidates)) throw new Error("candidates missing");
      if (typeof body.staleAt !== "number") throw new Error("staleAt missing");
      return `${body.totalVotes} votes counted`;
    },
  },
  {
    name: "GET /api/status",
    run: async () => {
      // Exercises the cookie/HMAC path, which needs COOKIE_SECRET to be set. A
      // missing secret surfaces here as a 500 rather than at the first real vote.
      const body = (await (await get("/api/status")).json()) as { hasVoted?: boolean };
      if (typeof body.hasVoted !== "boolean") throw new Error("hasVoted missing");
      return `hasVoted=${body.hasVoted}`;
    },
  },
  {
    name: "GET / (ballot renders)",
    run: async () => {
      const response = await fetch(baseUrl, { headers: { accept: "text/html" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();

      if (!html.includes("turnstile-host")) throw new Error("Turnstile host element missing");

      // The bug this guards against: one widget per candidate card. Anything
      // above a single host element means the per-card regression is back.
      const hosts = html.match(/id="turnstile-host"/g)?.length ?? 0;
      if (hosts !== 1) throw new Error(`expected exactly 1 Turnstile host, found ${hosts}`);

      const forms = html.match(/data-vote-form/g)?.length ?? 0;
      if (forms === 0) throw new Error("no vote forms rendered");

      // The ballot reveals this in place after a successful vote instead of
      // navigating to /thanks — that is what keeps a vote to two Worker
      // requests. If it stops being rendered, voting silently falls back to a
      // full navigation and the request budget quietly goes back up by 50%.
      if (!html.includes('id="vote-confirmation"')) {
        throw new Error("inline confirmation section missing");
      }

      return `${forms} vote forms, 1 Turnstile widget, inline confirmation present`;
    },
  },
  {
    name: "GET /results (page renders)",
    run: async () => {
      const response = await fetch(`${baseUrl}/results`, { headers: { accept: "text/html" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return "ok";
    },
  },
];

console.log(`Smoke testing ${baseUrl}\n`);

let failed = 0;
for (const check of checks) {
  try {
    const detail = await check.run();
    console.log(`  PASS  ${check.name} — ${detail}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${check.name} — ${(error as Error).message}`);
  }
}

console.log("");
if (failed > 0) {
  console.error(`${failed} of ${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks.length} checks passed.`);
