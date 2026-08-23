import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { Env } from "../env.ts";
import { rateLimit } from "./rate-limit.ts";
import { makeEnv, makeRequest, type EnvStub } from "../test-helpers.ts";

/** A one-route app so the middleware can be exercised in isolation. */
function appWith(options: { route: string; limit: number; windowMs: number }) {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/probe", rateLimit(options), (c) => c.text("ok"));
  return app;
}

function call(app: ReturnType<typeof appWith>, stub: EnvStub, path = "/probe") {
  return app.fetch(makeRequest(path), stub.env);
}

describe("rateLimit", () => {
  test("passes the request through when both layers allow it", async () => {
    const stub = makeEnv();
    const response = await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(stub.edgeCalls).toHaveLength(1);
    expect(stub.rateLimiter.calls).toHaveLength(1);
  });

  test("rejects with 429 when the edge binding says no", async () => {
    const stub = makeEnv({}, { edgeAllows: false });
    const response = await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("Too many requests");
  });

  test("does not pay for a DO round trip when the edge already rejected", async () => {
    // The whole point of layering: the cheap check must short-circuit.
    const stub = makeEnv({}, { edgeAllows: false });
    await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(stub.edgeCalls).toHaveLength(1);
    expect(stub.rateLimiter.calls).toHaveLength(0);
  });

  test("rejects with 429 when the Durable Object says no", async () => {
    const stub = makeEnv({}, { rateLimiterAllows: false });
    const response = await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);

    expect(response.status).toBe(429);
    expect(stub.edgeCalls).toHaveLength(1);
    expect(stub.rateLimiter.calls).toHaveLength(1);
  });

  test("enforces the configured limit across repeated calls", async () => {
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 3, windowMs: 60_000 });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await call(app, stub)).status);

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  test("passes the configured limit and window down to the DO", async () => {
    const stub = makeEnv();
    await call(appWith({ route: "status", limit: 30, windowMs: 60_000 }), stub);

    expect(stub.rateLimiter.calls[0]).toMatchObject({ limit: 30, windowMs: 60_000 });
  });

  test("keys per route so one route's budget cannot exhaust another's", async () => {
    const stub = makeEnv();
    await call(appWith({ route: "vote", limit: 5, windowMs: 60_000 }), stub);
    await call(appWith({ route: "status", limit: 30, windowMs: 60_000 }), stub);

    const keys = stub.rateLimiter.calls.map((c) => c.key);
    expect(keys[0]).toEndWith(":vote");
    expect(keys[1]).toEndWith(":status");
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("keys per identity so one voter cannot exhaust another's budget", async () => {
    const stub = makeEnv();
    const app = appWith({ route: "vote", limit: 5, windowMs: 60_000 });

    await app.fetch(makeRequest("/probe", { ip: "1.1.1.1" }), stub.env);
    await app.fetch(makeRequest("/probe", { ip: "2.2.2.2" }), stub.env);

    const [first, second] = stub.rateLimiter.calls;
    expect(first!.key).not.toBe(second!.key);
  });
});
