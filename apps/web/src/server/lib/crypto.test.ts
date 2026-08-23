import { describe, expect, test } from "bun:test";

import { sha256Hex, signToken, verifyToken } from "./crypto.ts";

const SECRET = "correct-horse-battery-staple";

describe("sha256Hex", () => {
  test("matches the known digest for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is 64 lowercase hex chars and deterministic", async () => {
    const digest = await sha256Hex("anything");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("anything")).toBe(digest);
  });

  test("differs for different input", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });
});

describe("signToken / verifyToken", () => {
  test("round-trips a payload", async () => {
    const token = await signToken({ c: "candidate-01", t: 1234 }, SECRET);
    expect(await verifyToken<{ c: string; t: number }>(token, SECRET)).toEqual({
      c: "candidate-01",
      t: 1234,
    });
  });

  test("produces a two-part base64url token", async () => {
    const token = await signToken({ c: "x" }, SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    // base64url: no +, /, or = padding.
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await signToken({ c: "candidate-01" }, SECRET);
    expect(await verifyToken(token, "some-other-secret")).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await signToken({ c: "candidate-01" }, SECRET);
    const [, signature] = token.split(".");
    const forged = await signToken({ c: "candidate-99" }, "irrelevant");
    const [forgedBody] = forged.split(".");

    // Swap in a different payload while keeping the original signature.
    expect(await verifyToken(`${forgedBody}.${signature}`, SECRET)).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const token = await signToken({ c: "candidate-01" }, SECRET);
    const [body] = token.split(".");
    expect(await verifyToken(`${body}.AAAA`, SECRET)).toBeNull();
  });

  test("rejects undefined, empty and malformed tokens", async () => {
    expect(await verifyToken(undefined, SECRET)).toBeNull();
    expect(await verifyToken("", SECRET)).toBeNull();
    expect(await verifyToken("no-separator", SECRET)).toBeNull();
    expect(await verifyToken(".onlysig", SECRET)).toBeNull();
    expect(await verifyToken("!!!.???", SECRET)).toBeNull();
  });

  test("survives non-ASCII payloads", async () => {
    const payload = { c: "café-∑-🗳" };
    const token = await signToken(payload, SECRET);
    expect(await verifyToken<typeof payload>(token, SECRET)).toEqual(payload);
  });
});
