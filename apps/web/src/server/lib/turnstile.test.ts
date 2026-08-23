import { afterEach, describe, expect, test } from "bun:test";

import { verifyTurnstile } from "./turnstile.ts";
import { stubFetch, turnstileResponder } from "../test-helpers.ts";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("verifyTurnstile", () => {
  test("posts the secret and token to siteverify", async () => {
    const stub = stubFetch(turnstileResponder(true));
    restore = stub.restore;

    await verifyTurnstile("token-abc", "secret-xyz");

    expect(stub.calls).toHaveLength(1);
    const request = stub.calls[0]!;
    expect(request.url).toBe(SITEVERIFY);
    expect(request.method).toBe("POST");

    const body = new URLSearchParams(request.body);
    expect(body.get("secret")).toBe("secret-xyz");
    expect(body.get("response")).toBe("token-abc");
  });

  test("includes remoteip only when given one", async () => {
    let stub = stubFetch(turnstileResponder(true));
    restore = stub.restore;
    await verifyTurnstile("t", "s", "198.51.100.4");
    expect(new URLSearchParams(stub.calls[0]!.body).get("remoteip")).toBe("198.51.100.4");
    stub.restore();

    stub = stubFetch(turnstileResponder(true));
    restore = stub.restore;
    await verifyTurnstile("t", "s");
    expect(new URLSearchParams(stub.calls[0]!.body).has("remoteip")).toBe(false);
  });

  test("is true only when the response says success", async () => {
    const pass = stubFetch(turnstileResponder(true));
    restore = pass.restore;
    expect(await verifyTurnstile("t", "s")).toBe(true);
    pass.restore();

    const fail = stubFetch(turnstileResponder(false));
    restore = fail.restore;
    expect(await verifyTurnstile("t", "s")).toBe(false);
  });

  test("fails closed on a non-OK HTTP response", async () => {
    // An outage at Cloudflare must not become a free pass past the challenge.
    const stub = stubFetch(turnstileResponder(true, false));
    restore = stub.restore;
    expect(await verifyTurnstile("t", "s")).toBe(false);
  });

  test("fails closed when the body omits success", async () => {
    const stub = stubFetch(
      () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    restore = stub.restore;
    expect(await verifyTurnstile("t", "s")).toBe(false);
  });
});
