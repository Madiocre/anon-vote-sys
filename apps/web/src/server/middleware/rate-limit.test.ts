import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { VOTER_COOKIE } from "@avs/shared";
import type { VoteResponse } from "@avs/shared";

import type { Env } from "../env.ts";
import { rateLimit } from "./rate-limit.ts";
import { makeEnv, makeRequest, type EnvStub } from "../test-helpers.ts";

/** A one-route app so the middleware can be exercised in isolation. */
function appWith(options: { route: string; limit: number; windowMs: number }) {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/probe", rateLimit(options), (c) => c.text("ok"));
  return app;
}

/** A request from a known voter (carries a `vid` cookie) at a given IP. */
function asVoter(voterId: string, ip = "203.0.113.7") {
  return makeRequest("/probe", { ip, cookies: { [VOTER_COOKIE]: voterId } });
}

function call(app: ReturnType<typeof appWith>, stub: EnvStub, request?: Request) {
  return app.fetch(request ?? makeRequest("/probe"), stub.env);
}

describe("rateLimit — happy path", () => {
  test("passes the request through when both layers allow it", async () => {
    const stub = makeEnv();
    const response = await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(stub.edgeCalls).toHaveLength(1);
    expect(stub.rateLimiter.calls).toHaveLength(1);
  });

  test("passes the configured limit and window down to the DO", async () => {
    const stub = makeEnv();
    await call(appWith({ route: "status", limit: 30, windowMs: 60_000 }), stub);

    expect(stub.rateLimiter.calls[0]).toMatchObject({ limit: 30, windowMs: 60_000 });
  });
});

describe("rateLimit — layer 1, the per-IP flood guard", () => {
  test("rejects with a 429 the ballot can parse", async () => {
    // The body matters: the vote page parses JSON and falls back to a generic
    // "could not be recorded, please try again" when parsing fails — which told
    // a rate-limited voter to do the one thing guaranteed not to work.
    const stub = makeEnv({}, { edgeAllows: false });
    const response = await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(response.status).toBe(429);
    expect((await response.json()) as VoteResponse).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  test("does not pay for a DO round trip when the edge already rejected", async () => {
    // The whole point of layering: the cheap check must short-circuit.
    const stub = makeEnv({}, { edgeAllows: false });
    await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(stub.edgeCalls).toHaveLength(1);
    expect(stub.rateLimiter.calls).toHaveLength(0);
  });

  test("stays keyed on the IP even for identified voters", async () => {
    // Layer 1 is deliberately per-IP: it is flood protection, not a per-voter
    // budget. Two different voters behind one address share this bucket, which
    // is why its ceiling in wrangler.jsonc is 300/min rather than 20.
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 5, windowMs: 60_000 });

    await call(app, stub, asVoter("voter-a", "198.51.100.1"));
    await call(app, stub, asVoter("voter-b", "198.51.100.1"));

    expect(stub.edgeCalls[0]!.key).toBe(stub.edgeCalls[1]!.key);
  });
});

describe("rateLimit — layer 2, the per-voter budget", () => {
  test("enforces the limit across repeated calls from one voter", async () => {
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 3, windowMs: 60_000 });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await call(app, stub, asVoter("voter-a"))).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  test("two voters behind ONE IP do not share a budget", async () => {
    // The regression this whole rekey exists for. Carrier-grade NAT puts
    // hundreds to thousands of mobile subscribers behind a single public IPv4.
    // When layer 2 was keyed on ip_hash, the sixth person to vote in a minute
    // from one carrier address got a 429 — and the ballot rendered that as
    // "Your vote could not be recorded", with retrying no help.
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 2, windowMs: 60_000 });
    const SHARED_IP = "198.51.100.42";

    // Voter A exhausts their own budget.
    expect((await call(app, stub, asVoter("voter-a", SHARED_IP))).status).toBe(200);
    expect((await call(app, stub, asVoter("voter-a", SHARED_IP))).status).toBe(200);
    expect((await call(app, stub, asVoter("voter-a", SHARED_IP))).status).toBe(429);

    // Voter B, same address, must be entirely unaffected.
    expect((await call(app, stub, asVoter("voter-b", SHARED_IP))).status).toBe(200);
    expect((await call(app, stub, asVoter("voter-c", SHARED_IP))).status).toBe(200);
  });

  test("keys the DO per voter, not per IP", async () => {
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 5, windowMs: 60_000 });

    await call(app, stub, asVoter("voter-a", "198.51.100.1"));
    await call(app, stub, asVoter("voter-b", "198.51.100.1"));

    const [first, second] = stub.rateLimiter.calls;
    expect(first!.key).toStartWith("voter-a:");
    expect(second!.key).toStartWith("voter-b:");
  });

  test("one voter's budget is independent per route", async () => {
    const stub = makeEnv();
    const voter = asVoter("voter-a");

    await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub, voter);
    await call(appWith({ route: "status", limit: 30, windowMs: 60_000 }), stub, asVoter("voter-a"));

    const keys = stub.rateLimiter.calls.map((c) => c.key);
    expect(keys[0]).toEndWith(":vote");
    expect(keys[1]).toEndWith(":status");
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a voter is limited regardless of which IP they arrive from", async () => {
    // Roaming between wifi and mobile data must not reset the budget.
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 2, windowMs: 60_000 });

    await call(app, stub, asVoter("voter-a", "198.51.100.1"));
    await call(app, stub, asVoter("voter-a", "203.0.113.99"));
    const third = await call(app, stub, asVoter("voter-a", "192.0.2.50"));

    expect(third.status).toBe(429);
  });
});

describe("rateLimit — cookie-less fallback", () => {
  test("falls back to IP keying when there is no vid cookie", async () => {
    // Without a cookie every request would mint a fresh voter id, so a
    // per-voter budget would be no budget at all. Those requests share an
    // IP-keyed bucket instead — cookie-less traffic is already anomalous, so
    // that is the right place to accept sharing.
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 2, windowMs: 60_000 });
    const anonymous = () => makeRequest("/probe", { ip: "198.51.100.77" });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call(app, stub, anonymous())).status);

    expect(statuses).toEqual([200, 200, 429, 429]);

    // And the key really is the ip hash, not a per-request uuid.
    const keys = new Set(stub.rateLimiter.calls.map((c) => c.key));
    expect(keys.size).toBe(1);
  });

  test("a cookie-less flood does not consume an identified voter's budget", async () => {
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 2, windowMs: 60_000 });
    const SHARED_IP = "198.51.100.88";

    await call(app, stub, makeRequest("/probe", { ip: SHARED_IP }));
    await call(app, stub, makeRequest("/probe", { ip: SHARED_IP }));
    expect((await call(app, stub, makeRequest("/probe", { ip: SHARED_IP }))).status).toBe(429);

    expect((await call(app, stub, asVoter("voter-a", SHARED_IP))).status).toBe(200);
  });
});
