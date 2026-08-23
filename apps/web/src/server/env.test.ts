import { describe, expect, test } from "bun:test";

import { requireSecret, resultsTtl, type Env } from "./env.ts";
import { makeEnv } from "./test-helpers.ts";

describe("resultsTtl", () => {
  test("uses the configured value when it is a positive number", () => {
    expect(resultsTtl(makeEnv({ RESULTS_TTL_SECONDS: "60" }).env)).toBe(60);
  });

  test("falls back to the shared default when unset", () => {
    expect(resultsTtl(makeEnv({ RESULTS_TTL_SECONDS: undefined }).env)).toBe(600);
  });

  const badValues: Array<[string, string]> = [
    ["empty string", ""],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-30"],
  ];

  test.each(badValues)("falls back for %s", (_label: string, value: string) => {
    expect(resultsTtl(makeEnv({ RESULTS_TTL_SECONDS: value }).env)).toBe(600);
  });
});

describe("requireSecret", () => {
  test("returns the value when present", () => {
    expect(requireSecret(makeEnv().env, "VOTE_SALT")).toBe("test-salt");
  });

  test("throws naming the missing key", () => {
    const env = makeEnv({ COOKIE_SECRET: undefined as unknown as string }).env;
    expect(() => requireSecret(env, "COOKIE_SECRET")).toThrow(/COOKIE_SECRET/);
  });

  test("treats an empty string as missing", () => {
    // A secret that was created but never given a value is the realistic case
    // here, and it must fail loudly rather than silently signing with "".
    const env = makeEnv({ COOKIE_SECRET: "" }).env;
    expect(() => requireSecret(env, "COOKIE_SECRET")).toThrow(/COOKIE_SECRET/);
  });

  test("rejects a non-string binding", () => {
    const env = makeEnv().env as Env;
    expect(() => requireSecret(env, "DB")).toThrow(/DB/);
  });
});
