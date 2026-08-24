import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";

import { createDb, recordVote } from "@avs/db";
import { ROUTES, VOTER_COOKIE, VOTE_COOKIE } from "@avs/shared";
import type { VoteResponse } from "@avs/shared";

import { resultsTtl, type Env, type WaitUntil } from "./env";
import { cookieAttributes, getVoterStatus, issueVoteToken, resolveIdentity } from "./lib/identity";
import { getCachedCandidates, getCachedResults } from "./lib/cache";
import { verifyTurnstile } from "./lib/turnstile";
import { rateLimit } from "./middleware/rate-limit";

type App = Context<{ Bindings: Env }>;

/**
 * `c.executionCtx` throws rather than returning undefined when there is no
 * context behind it, which happens under some dev servers. cache.ts only ever
 * needs `waitUntil`, and degrades gracefully without one.
 */
function execCtx(c: App): WaitUntil | undefined {
  try {
    return c.executionCtx as WaitUntil;
  } catch {
    return undefined;
  }
}

/**
 * Decides whether this caller wants JSON back or an ordinary browser redirect.
 *
 * The ballot posts a real `<form method="POST" action="/api/vote">`, so voting
 * keeps working with JavaScript disabled — that path needs a 303 to /thanks,
 * not a JSON body rendered as raw text. The inline script on the ballot upgrades
 * the same form to `fetch` with `content-type: application/json`, which lands
 * here as JSON. The `accept` test is last and deliberately excludes text/html,
 * since a browser form post sends a wildcard Accept header that would otherwise
 * match.
 */
function wantsJson(c: App): boolean {
  const contentType = c.req.header("content-type") ?? "";
  const accept = c.req.header("accept") ?? "";
  return (
    contentType.includes("application/json") ||
    c.req.header("x-requested-with") === "fetch" ||
    (accept.includes("application/json") && !accept.includes("text/html"))
  );
}

/**
 * Writes both identity cookies. Called on a successful vote AND on a duplicate —
 * someone whose vote is already on record should leave with a cookie proving it,
 * so the next visit is answered without touching D1.
 *
 * SameSite=Lax matters here: the no-JS path lands on /thanks via a 303, and a
 * cookie set with SameSite=Strict would not be sent on that navigation.
 */
async function persistVoteCookies(c: App, voterId: string, candidateId: string): Promise<void> {
  const attributes = { ...cookieAttributes(c.req.raw), sameSite: "Lax" as const };
  setCookie(c, VOTER_COOKIE, voterId, attributes);
  setCookie(c, VOTE_COOKIE, await issueVoteToken(candidateId, c.env), attributes);
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Without this an unhandled throw — requireSecret() on a missing secret, a D1
 * outage — escapes as Hono's default plain-text 500, which the ballot's fetch
 * handler cannot parse. This is the only place `server_error` is produced.
 */
app.onError((error, c) => {
  console.error("[api]", error);
  const body: VoteResponse = {
    ok: false,
    error: "server_error",
    message: "Something went wrong on our side. Please try again.",
  };
  return c.json(body, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, ttlSeconds: resultsTtl(c.env) }));

app.get("/api/candidates", async (c) => {
  const { value: candidates, hit } = await getCachedCandidates(c.env, execCtx(c));
  c.header("cache-control", `public, max-age=0, s-maxage=${resultsTtl(c.env)}`);
  c.header("x-cache", hit ? "HIT" : "MISS");
  return c.json({ candidates });
});

/**
 * The public results feed. Served from the edge cache, so D1 reads are bounded
 * by (colos x TTL) rather than by traffic. `?fresh=1` bypasses the cache for
 * debugging and is not linked from the UI.
 */
app.get("/api/results", async (c) => {
  const bypass = c.req.query("fresh") === "1";
  const { value: results, hit } = await getCachedResults(c.env, execCtx(c), { bypass });

  c.header("cache-control", `public, max-age=0, s-maxage=${results.ttlSeconds}`);
  c.header("x-cache", bypass ? "BYPASS" : hit ? "HIT" : "MISS");
  return c.json(results);
});

/** Lets the client ask "have I already voted?" without rendering a page. */
app.get("/api/status", rateLimit({ route: "status", limit: 30, windowMs: 60_000 }), async (c) => {
  const identity = await resolveIdentity(c.req.raw, c.env);
  const status = await getVoterStatus(c.req.raw, c.env, identity);

  // Hand out the anonymous voter id now, so a ballot rendered after this call is
  // already tied to an identifier by the time it is submitted.
  if (identity.isNew) {
    setCookie(c, VOTER_COOKIE, identity.voterId, {
      ...cookieAttributes(c.req.raw),
      sameSite: "Lax",
    });
  }

  c.header("cache-control", "no-store");
  return c.json(status);
});

app.post("/api/vote", rateLimit({ route: "vote", limit: 5, windowMs: 60_000 }), async (c) => {
  const json = wantsJson(c);
  const identity = await resolveIdentity(c.req.raw, c.env);

  // Already voted? Short-circuit before Turnstile, the DO, or D1 get touched.
  const status = await getVoterStatus(c.req.raw, c.env, identity);
  if (status.hasVoted) {
    const body: VoteResponse = {
      ok: false,
      error: "already_voted",
      message: "You've already voted.",
      candidateId: status.candidateId ?? undefined,
    };
    return json ? c.json(body, 409) : c.redirect(ROUTES.thanks, 303);
  }

  // Supports both the JS-upgraded JSON POST and a plain no-JS form POST.
  let candidateId: string | undefined;
  let turnstileToken: string | undefined;

  if (c.req.header("content-type")?.includes("application/json")) {
    const parsed = await c.req.json<{ candidateId?: string; turnstileToken?: string }>();
    candidateId = parsed.candidateId;
    turnstileToken = parsed.turnstileToken;
  } else {
    const form = await c.req.formData();
    candidateId = form.get("candidateId")?.toString();
    // Turnstile's implicit-render mode injects this field name into the form
    // automatically once the challenge is solved — the markup in
    // CandidateCard.astro never names it.
    turnstileToken = form.get("cf-turnstile-response")?.toString();
  }

  if (!candidateId) {
    const body: VoteResponse = {
      ok: false,
      error: "invalid_request",
      message: "No candidate was selected.",
    };
    return json ? c.json(body, 400) : c.redirect(`${ROUTES.vote}?error=invalid_request`, 303);
  }

  // A missing token and a rejected token are the same failure to the voter: the
  // challenge did not pass. Distinct HTTP codes (400 vs 403) because only one of
  // them means the request was malformed.
  if (!turnstileToken) {
    const body: VoteResponse = {
      ok: false,
      error: "verification_failed",
      message: "The anti-robot check didn't complete. Please try again.",
    };
    return json ? c.json(body, 400) : c.redirect(`${ROUTES.vote}?error=verification_failed`, 303);
  }

  const verified = await verifyTurnstile(
    turnstileToken,
    c.env.TURNSTILE_SECRET,
    c.req.header("cf-connecting-ip") ?? undefined,
  );
  if (!verified) {
    const body: VoteResponse = {
      ok: false,
      error: "verification_failed",
      message: "The anti-robot check didn't pass. Please try again.",
    };
    return json ? c.json(body, 403) : c.redirect(`${ROUTES.vote}?error=verification_failed`, 303);
  }

  // Candidate must be real. Checked against the cached list rather than a fresh
  // D1 read — it is the same read /api/candidates already serves, so this costs
  // nothing beyond what rendering the ballot already paid for.
  const { value: candidates } = await getCachedCandidates(c.env, execCtx(c));
  if (!candidates.some((candidate) => candidate.id === candidateId)) {
    const body: VoteResponse = {
      ok: false,
      error: "unknown_candidate",
      message: "That candidate is not on the ballot.",
    };
    return json ? c.json(body, 400) : c.redirect(`${ROUTES.vote}?error=unknown_candidate`, 303);
  }

  // The UNIQUE index on voter_id is the dedup mechanism, full stop.
  //
  // A `VoteGate` Durable Object used to sit in front of this as a "fast first
  // claim". It was removed: by the time execution reaches here, getVoterStatus
  // has already established that D1 holds no row for this voter, so the only
  // job left for the gate was the concurrent-double-submit race — which
  // onConflictDoNothing already wins atomically, returning the same 409 with
  // the candidate actually on record. It duplicated a constraint at the cost of
  // half the app's Durable Object budget.
  const outcome = await recordVote(createDb(c.env.DB), {
    id: crypto.randomUUID(),
    candidateId,
    voterId: identity.voterId,
    ipHash: identity.ipHash,
    userAgent: c.req.header("user-agent") ?? null,
  });

  const finalCandidateId = outcome.status === "recorded" ? candidateId : outcome.candidateId;
  await persistVoteCookies(c, identity.voterId, finalCandidateId);

  if (outcome.status === "duplicate") {
    // D1's constraint caught something the DO gate missed — the DO's storage was
    // reset, the instance is fresh for a rotated id, and so on. Rare, but the
    // cookie above still ends up pointing at the correct existing pick.
    const body: VoteResponse = {
      ok: false,
      error: "already_voted",
      message: "You've already voted.",
      candidateId: finalCandidateId,
    };
    return json ? c.json(body, 409) : c.redirect(ROUTES.thanks, 303);
  }

  const body: VoteResponse = { ok: true, candidateId: finalCandidateId };
  return json ? c.json(body, 201) : c.redirect(ROUTES.thanks, 303);
});

export default app;
