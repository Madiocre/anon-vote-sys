import { Hono } from "hono";
import { setCookie } from "hono/cookie";

import { createDb, recordVote } from "@avs/db";
import { VOTER_COOKIE, VOTE_COOKIE } from "@avs/shared";
import type { VoteResponse } from "@avs/shared";

import type { Env } from "./env";
import { cookieAttributes, getVoterStatus, issueVoteToken, resolveIdentity } from "./lib/identity";
import { getCachedCandidates, getCachedResults } from "./lib/cache";
import { verifyTurnstile } from "./lib/turnstile";
import { rateLimit } from "./middleware/rate-limit";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/candidates", async (c) => {
  const { value: candidates, hit } = await getCachedCandidates(c.env, c.executionCtx);
  return c.json({ candidates }, 200, { "x-cache": hit ? "hit" : "miss" });
});

app.get("/api/results", async (c) => {
  const { value: results, hit } = await getCachedResults(c.env, c.executionCtx);
  return c.json(results, 200, { "x-cache": hit ? "hit" : "miss" });
});

app.get("/api/status", rateLimit({ route: "status", limit: 30, windowMs: 60_000 }), async (c) => {
  const identity = await resolveIdentity(c.req.raw, c.env);
  const status = await getVoterStatus(c.req.raw, c.env, identity);
  return c.json(status);
});

app.post("/api/vote", rateLimit({ route: "vote", limit: 5, windowMs: 60_000 }), async (c) => {
  const identity = await resolveIdentity(c.req.raw, c.env);

  // Already voted? Short-circuit before Turnstile, the DO, or D1 get touched at all.
  const status = await getVoterStatus(c.req.raw, c.env, identity);
  if (status.hasVoted) {
    const body: VoteResponse = {
      ok: false,
      error: "already_voted",
      message: "You've already voted.",
      candidateId: status.candidateId ?? undefined,
    };
    return c.json(body, 409);
  }

  // Supports both a JS-upgraded JSON POST and a plain no-JS form POST — see
  // CandidateCard.astro's progressive-enhancement submit handler.
  let candidateId: string | undefined;
  let turnstileToken: string | undefined;
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const parsed = await c.req.json<{ candidateId?: string; turnstileToken?: string }>();
    candidateId = parsed.candidateId;
    turnstileToken = parsed.turnstileToken;
  } else {
    const form = await c.req.formData();
    candidateId = form.get("candidateId")?.toString();
    // Turnstile's implicit-render mode injects this field name automatically —
    // see AGENTS.md §0. Not something the form markup names by hand.
    turnstileToken = form.get("cf-turnstile-response")?.toString();
  }

  if (!candidateId) {
    const body: VoteResponse = { ok: false, error: "invalid_request", message: "Missing candidateId." };
    return c.json(body, 400);
  }

  if (!turnstileToken) {
    const body: VoteResponse = {
      ok: false,
      error: "invalid_request",
      message: "Missing verification token.",
    };
    return c.json(body, 400);
  }

  const clientIp = c.req.header("cf-connecting-ip") ?? undefined;
  const verified = await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET, clientIp);
  if (!verified) {
    const body: VoteResponse = { ok: false, error: "invalid_request", message: "Verification failed." };
    return c.json(body, 403);
  }

  // Candidate must be real. Checked against the cached list rather than a
  // fresh D1 read — getCachedCandidates() is the same read /api/candidates
  // already serves, so this doesn't cost anything beyond what the ballot page
  // already paid for.
  const { value: candidates } = await getCachedCandidates(c.env, c.executionCtx);
  if (!candidates.some((candidate) => candidate.id === candidateId)) {
    const body: VoteResponse = { ok: false, error: "unknown_candidate", message: "Unknown candidate." };
    return c.json(body, 400);
  }

  // Durable Object gate — the fast, globally-consistent first claim. Checked
  // AFTER Turnstile deliberately: no reason to spend a DO round trip on a
  // request that was already going to be rejected for an unrelated reason.
  const gateId = c.env.VOTE_GATE.idFromName(identity.ipHash);
  const gate = c.env.VOTE_GATE.get(gateId);
  const claimed = await gate.claim();
  if (!claimed) {
    const body: VoteResponse = { ok: false, error: "already_voted", message: "You've already voted." };
    return c.json(body, 409);
  }

  // The D1 UNIQUE indexes remain the actual source of truth — the DO claim
  // above is a fast-path optimization layered in front of them, not a
  // replacement (AGENTS.md §0).
  const db = createDb(c.env.DB);
  const outcome = await recordVote(db, {
    id: crypto.randomUUID(),
    candidateId,
    voterId: identity.voterId,
    ipHash: identity.ipHash,
    userAgent: c.req.header("user-agent") ?? null,
  });

  const finalCandidateId = outcome.status === "recorded" ? candidateId : outcome.candidateId;

  const attrs = cookieAttributes(c.req.raw);
  setCookie(c, VOTER_COOKIE, identity.voterId, attrs);
  setCookie(c, VOTE_COOKIE, await issueVoteToken(finalCandidateId, c.env), attrs);

  if (outcome.status === "duplicate") {
    // D1's constraint caught something the DO gate missed — the DO's storage
    // was reset, this is a fresh instance for an id that's rotated, etc. Rare,
    // but the cookie still gets set to the correct existing pick either way.
    const body: VoteResponse = {
      ok: false,
      error: "already_voted",
      message: "You've already voted.",
      candidateId: finalCandidateId,
    };
    return c.json(body, 409);
  }

  const body: VoteResponse = { ok: true, candidateId: finalCandidateId };
  return c.json(body);
});

export default app;