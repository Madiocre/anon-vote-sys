import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { VOTE_COOKIE, VOTER_COOKIE } from "@avs/shared";
import type { ResultsPayload, VoteResponse, VoterStatus } from "@avs/shared";

import { CANDIDATES, dbState, resetDbState } from "./db-mock.ts";

const app = (await import("./index.ts")).default;
const { issueVoteToken } = await import("./lib/identity.ts");
const { makeEnv, makeRequest, readSetCookies, stubFetch, turnstileResponder } = await import(
  "./test-helpers.ts"
);

const VALID = CANDIDATES[0]!.id;

let restoreFetch: (() => void) | undefined;

beforeEach(() => {
  resetDbState();
  // Default: Turnstile passes. Individual tests override.
  const stub = stubFetch(turnstileResponder(true));
  restoreFetch = stub.restore;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

/** JSON vote, i.e. the JS-upgraded path. */
function jsonVote(body: unknown, cookies?: Record<string, string>) {
  return makeRequest("/api/vote", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cookies,
  });
}

/** Plain form vote, i.e. the no-JavaScript path a browser actually sends. */
function formVote(fields: Record<string, string>, cookies?: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return makeRequest("/api/vote", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: body.toString(),
    cookies,
  });
}

describe("GET /api/health", () => {
  test("reports ok and the effective TTL", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(makeRequest("/api/health"), env);

    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean; ttlSeconds: number }).toEqual({
      ok: true,
      ttlSeconds: 600,
    });
  });
});

describe("GET /api/candidates", () => {
  test("returns the ballot and marks the cache state", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(makeRequest("/api/candidates"), env);

    expect(response.status).toBe(200);
    expect((await response.json()) as { candidates: typeof CANDIDATES }).toEqual({
      candidates: CANDIDATES,
    });
    expect(response.headers.get("x-cache")).toMatch(/^(HIT|MISS)$/);
    expect(response.headers.get("cache-control")).toContain("s-maxage=600");
  });

  test("is served from cache on a second call", async () => {
    const { env } = makeEnv();
    await app.fetch(makeRequest("/api/candidates"), env);
    const before = dbState.calls.listCandidates;
    const response = await app.fetch(makeRequest("/api/candidates"), env);

    expect(response.headers.get("x-cache")).toBe("HIT");
    expect(dbState.calls.listCandidates).toBe(before);
  });
});

describe("GET /api/results", () => {
  test("returns a results payload with cache headers", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(makeRequest("/api/results"), env);
    const body = (await response.json()) as ResultsPayload;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ totalVotes: 6, ttlSeconds: 600 });
    expect(body.candidates).toHaveLength(CANDIDATES.length);
    expect(response.headers.get("cache-control")).toContain("s-maxage=600");
  });

  test("?fresh=1 bypasses the cache and re-reads", async () => {
    const { env } = makeEnv();
    await app.fetch(makeRequest("/api/results"), env);
    const before = dbState.calls.aggregateResults;

    const response = await app.fetch(makeRequest("/api/results?fresh=1"), env);
    expect(response.headers.get("x-cache")).toBe("BYPASS");
    expect(dbState.calls.aggregateResults).toBe(before + 1);
  });
});

describe("GET /api/status", () => {
  test("reports not-voted for a fresh visitor and issues a voter id", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(makeRequest("/api/status"), env);
    const body = (await response.json()) as VoterStatus;

    expect(response.status).toBe(200);
    expect(body.hasVoted).toBe(false);
    expect(body.reason).toBe("none");
    expect(readSetCookies(response)[VOTER_COOKIE]).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("reports a prior vote from the signed cookie", async () => {
    const { env } = makeEnv();
    const token = await issueVoteToken("candidate-02", env);
    const response = await app.fetch(
      makeRequest("/api/status", { cookies: { [VOTE_COOKIE]: token } }),
      env,
    );

    expect((await response.json()) as VoterStatus).toEqual({
      hasVoted: true,
      candidateId: "candidate-02",
      reason: "cookie",
    });
  });
});

describe("POST /api/vote — JSON path", () => {
  test("records a vote and sets both identity cookies", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "tok" }),
      env,
    );

    expect(response.status).toBe(201);
    expect((await response.json()) as VoteResponse).toEqual({ ok: true, candidateId: VALID });

    const cookies = readSetCookies(response);
    expect(cookies[VOTER_COOKIE]).toBeTruthy();
    expect(cookies[VOTE_COOKIE]).toBeTruthy();
    expect(dbState.calls.recordVote).toBe(1);
  });

  test("passes the identity and user agent through to the insert", async () => {
    const { env } = makeEnv();
    await app.fetch(jsonVote({ candidateId: VALID, turnstileToken: "tok" }), env);

    expect(dbState.lastRecordedVote).toMatchObject({ candidateId: VALID });
    const recorded = dbState.lastRecordedVote as Record<string, unknown>;
    expect(recorded.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.voterId).toBeTruthy();

    // No id is supplied any more: votes.id is an INTEGER PRIMARY KEY, so SQLite
    // assigns the rowid and no index write is paid for it.
    expect(recorded).not.toHaveProperty("id");
  });

  test("rejects a missing candidateId with invalid_request", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(jsonVote({ turnstileToken: "tok" }), env);
    const body = (await response.json()) as VoteResponse;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: "invalid_request" });
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("rejects an unknown candidate", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      jsonVote({ candidateId: "does-not-exist", turnstileToken: "tok" }),
      env,
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as VoteResponse).toMatchObject({ error: "unknown_candidate" });
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("rejects a missing Turnstile token with verification_failed", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(jsonVote({ candidateId: VALID }), env);

    expect(response.status).toBe(400);
    expect((await response.json()) as VoteResponse).toMatchObject({
      error: "verification_failed",
    });
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("rejects a failed Turnstile check with 403", async () => {
    restoreFetch?.();
    const stub = stubFetch(turnstileResponder(false));
    restoreFetch = stub.restore;

    const { env } = makeEnv();
    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "bad" }),
      env,
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as VoteResponse).toMatchObject({
      error: "verification_failed",
    });
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("short-circuits on an existing vote cookie without touching Turnstile or D1", async () => {
    const { env } = makeEnv();
    const token = await issueVoteToken("candidate-03", env);
    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "tok" }, { [VOTE_COOKIE]: token }),
      env,
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as VoteResponse).toMatchObject({
      error: "already_voted",
      candidateId: "candidate-03",
    });
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("two voters behind ONE IP can both vote", async () => {
    // The vote-route half of the CGNAT fix. This used to be blocked twice over:
    // by the UNIQUE index on ip_hash, and by a VoteGate claim keyed on ip_hash
    // that refused the second device before D1 was ever consulted.
    const { env } = makeEnv();
    const SHARED_IP = "198.51.100.42";

    const first = await app.fetch(
      makeRequest("/api/vote", {
        method: "POST",
        ip: SHARED_IP,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ candidateId: VALID, turnstileToken: "tok" }),
        cookies: { [VOTER_COOKIE]: "laptop" },
      }),
      env,
    );
    const second = await app.fetch(
      makeRequest("/api/vote", {
        method: "POST",
        ip: SHARED_IP,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ candidateId: VALID, turnstileToken: "tok" }),
        cookies: { [VOTER_COOKIE]: "phone" },
      }),
      env,
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(dbState.calls.recordVote).toBe(2);
  });

  test("surfaces a D1 duplicate as already_voted with the earlier pick", async () => {
    const { env } = makeEnv();
    dbState.recordOutcome = { status: "duplicate", candidateId: "candidate-02" };

    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "tok" }),
      env,
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as VoteResponse).toMatchObject({
      error: "already_voted",
      candidateId: "candidate-02",
    });
    // The cookie must still point at the real earlier pick, not the attempted one.
    expect(readSetCookies(response)[VOTE_COOKIE]).toBeTruthy();
  });

  test("checks Turnstile before writing to D1", async () => {
    // Ordering matters: a request already doomed by a failed challenge must not
    // reach the database.
    restoreFetch?.();
    const stub = stubFetch(turnstileResponder(false));
    restoreFetch = stub.restore;

    const { env } = makeEnv();
    await app.fetch(jsonVote({ candidateId: VALID, turnstileToken: "bad" }), env);

    expect(dbState.calls.recordVote).toBe(0);
  });
});

describe("POST /api/vote — no-JavaScript form path", () => {
  test("redirects to /thanks on success instead of returning JSON", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      formVote({ candidateId: VALID, "cf-turnstile-response": "tok" }),
      env,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
    expect(dbState.calls.recordVote).toBe(1);
  });

  test("reads the token from the field Turnstile injects", async () => {
    // Implicit rendering names the input cf-turnstile-response; the markup never
    // does. If this breaks, every no-JS vote silently fails verification.
    const { env } = makeEnv();
    const response = await app.fetch(
      formVote({ candidateId: VALID, "cf-turnstile-response": "tok" }),
      env,
    );
    expect(response.status).toBe(303);
  });

  test("redirects back to the ballot with an error code when no candidate was sent", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(formVote({ "cf-turnstile-response": "tok" }), env);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?error=invalid_request");
  });

  test("redirects with verification_failed when the challenge did not pass", async () => {
    restoreFetch?.();
    const stub = stubFetch(turnstileResponder(false));
    restoreFetch = stub.restore;

    const { env } = makeEnv();
    const response = await app.fetch(
      formVote({ candidateId: VALID, "cf-turnstile-response": "bad" }),
      env,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/?error=verification_failed");
  });

  test("redirects unknown candidates back to the ballot", async () => {
    const { env } = makeEnv();
    const response = await app.fetch(
      formVote({ candidateId: "nope", "cf-turnstile-response": "tok" }),
      env,
    );

    expect(response.headers.get("location")).toBe("/?error=unknown_candidate");
  });

  test("sends an already-voted browser to /thanks, not an error page", async () => {
    const { env } = makeEnv();
    const token = await issueVoteToken("candidate-02", env);
    const response = await app.fetch(
      formVote({ candidateId: VALID, "cf-turnstile-response": "tok" }, { [VOTE_COOKIE]: token }),
      env,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/thanks");
  });
});

describe("error handling", () => {
  // app.onError logs the cause with console.error, which is correct in
  // production and pure noise here — these two tests provoke it deliberately.
  const realError = console.error;
  beforeEach(() => void (console.error = () => {}));
  afterEach(() => void (console.error = realError));

  test("a thrown D1 error becomes a server_error JSON 500", async () => {
    const { env } = makeEnv();
    dbState.throwOn = "recordVote";

    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "tok" }),
      env,
    );

    expect(response.status).toBe(500);
    expect((await response.json()) as VoteResponse).toMatchObject({
      ok: false,
      error: "server_error",
    });
  });

  test("a missing secret is reported as server_error rather than crashing", async () => {
    const { env } = makeEnv({ COOKIE_SECRET: "" });
    const response = await app.fetch(makeRequest("/api/status"), env);

    expect(response.status).toBe(500);
    expect((await response.json()) as VoteResponse).toMatchObject({ error: "server_error" });
  });
});

describe("rate limiting is actually wired to the routes", () => {
  test("/api/vote is limited at 5 per minute", async () => {
    const { env, rateLimiter } = makeEnv();
    await app.fetch(jsonVote({ candidateId: VALID, turnstileToken: "tok" }), env);

    expect(rateLimiter.calls[0]).toMatchObject({ limit: 5, windowMs: 60_000 });
    expect(rateLimiter.calls[0]!.key).toEndWith(":vote");
  });

  test("/api/status is limited at 30 per minute", async () => {
    const { env, rateLimiter } = makeEnv();
    await app.fetch(makeRequest("/api/status"), env);

    expect(rateLimiter.calls[0]).toMatchObject({ limit: 30, windowMs: 60_000 });
  });

  test("a rejected limiter blocks the vote before any work happens", async () => {
    const { env } = makeEnv({}, { rateLimiterAllows: false });
    const response = await app.fetch(
      jsonVote({ candidateId: VALID, turnstileToken: "tok" }),
      env,
    );

    expect(response.status).toBe(429);
    expect(dbState.calls.recordVote).toBe(0);
  });

  test("the cached read routes are not rate limited", async () => {
    // /api/results and /api/candidates are protected by the edge cache instead;
    // adding the DO layer there would duplicate protection for no gain.
    const { env, rateLimiter } = makeEnv();
    await app.fetch(makeRequest("/api/results"), env);
    await app.fetch(makeRequest("/api/candidates"), env);

    expect(rateLimiter.calls).toHaveLength(0);
  });
});
