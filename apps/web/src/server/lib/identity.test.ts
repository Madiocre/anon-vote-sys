import { beforeEach, describe, expect, test } from "bun:test";

import { VOTE_COOKIE, VOTER_COOKIE } from "@avs/shared";

// Registers the shared @avs/db mock. Must be imported before identity.ts so the
// mock is in the registry by the time it resolves its own import.
import { dbState, resetDbState } from "../db-mock.ts";

const {
  computeIpHash,
  cookieAttributes,
  getVoterStatus,
  issueVoteToken,
  readCookie,
  readVotedCandidateId,
  resolveClientIp,
  resolveIdentity,
} = await import("./identity.ts");
const { makeEnv, makeRequest } = await import("../test-helpers.ts");

beforeEach(resetDbState);

describe("readCookie", () => {
  const withCookie = (value: string) =>
    new Request("https://vote.test/", { headers: { cookie: value } });

  test("reads a lone cookie", () => {
    expect(readCookie(withCookie("vid=abc"), "vid")).toBe("abc");
  });

  test("reads one of several", () => {
    expect(readCookie(withCookie("a=1; vid=abc; z=9"), "vid")).toBe("abc");
  });

  test("url-decodes the value", () => {
    expect(readCookie(withCookie("vid=a%20b%3Dc"), "vid")).toBe("a b=c");
  });

  test("returns undefined when absent or when there is no cookie header", () => {
    expect(readCookie(withCookie("other=1"), "vid")).toBeUndefined();
    expect(readCookie(new Request("https://vote.test/"), "vid")).toBeUndefined();
  });

  test("does not match a cookie whose name merely contains the target", () => {
    // "myvid" must not satisfy a lookup for "vid".
    expect(readCookie(withCookie("myvid=nope"), "vid")).toBeUndefined();
  });

  test("tolerates surrounding whitespace", () => {
    expect(readCookie(withCookie("  a=1 ;   vid=abc  "), "vid")).toBe("abc");
  });
});

describe("resolveClientIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request("https://vote.test/", { headers });

  test("prefers cf-connecting-ip", () => {
    const request = withHeaders({
      "cf-connecting-ip": "1.1.1.1",
      "x-real-ip": "2.2.2.2",
      "x-forwarded-for": "3.3.3.3",
    });
    expect(resolveClientIp(request)).toBe("1.1.1.1");
  });

  test("falls back to x-real-ip, then x-forwarded-for", () => {
    expect(resolveClientIp(withHeaders({ "x-real-ip": "2.2.2.2" }))).toBe("2.2.2.2");
    expect(resolveClientIp(withHeaders({ "x-forwarded-for": "3.3.3.3" }))).toBe("3.3.3.3");
  });

  test("takes only the first entry of x-forwarded-for", () => {
    const request = withHeaders({ "x-forwarded-for": "3.3.3.3, 4.4.4.4, 5.5.5.5" });
    expect(resolveClientIp(request)).toBe("3.3.3.3");
  });

  test("returns null when no header is present or the value is blank", () => {
    expect(resolveClientIp(withHeaders({}))).toBeNull();
    expect(resolveClientIp(withHeaders({ "x-forwarded-for": "" }))).toBeNull();
  });
});

describe("computeIpHash", () => {
  const { env } = makeEnv();

  test("is deterministic for the same IP and salt", async () => {
    const request = makeRequest("/", { ip: "9.9.9.9" });
    expect(await computeIpHash(request, "voter-a", env)).toBe(
      await computeIpHash(request, "voter-b", env),
    );
  });

  test("differs for a different IP", async () => {
    const a = await computeIpHash(makeRequest("/", { ip: "9.9.9.9" }), "v", env);
    const b = await computeIpHash(makeRequest("/", { ip: "8.8.8.8" }), "v", env);
    expect(a).not.toBe(b);
  });

  test("differs when the salt changes", async () => {
    // This is exactly why VOTE_SALT must not be rotated mid-election: every
    // voter re-hashes to a brand-new identity.
    const request = makeRequest("/", { ip: "9.9.9.9" });
    const a = await computeIpHash(request, "v", env);
    const b = await computeIpHash(request, "v", makeEnv({ VOTE_SALT: "different" }).env);
    expect(a).not.toBe(b);
  });

  test("falls back to the voter id when there is no IP", async () => {
    // Without this, every local request would collapse onto one shared hash and
    // lock the whole machine out after a single vote.
    const request = makeRequest("/", { ip: "" });
    const a = await computeIpHash(request, "voter-a", env);
    const b = await computeIpHash(request, "voter-b", env);
    expect(a).not.toBe(b);
  });
});

describe("resolveIdentity", () => {
  const { env } = makeEnv();

  test("mints a voter id and flags it new when there is no cookie", async () => {
    const identity = await resolveIdentity(makeRequest("/"), env);
    expect(identity.isNew).toBe(true);
    expect(identity.voterId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reuses an existing voter id and is not new", async () => {
    const request = makeRequest("/", { cookies: { [VOTER_COOKIE]: "existing-id" } });
    const identity = await resolveIdentity(request, env);
    expect(identity.voterId).toBe("existing-id");
    expect(identity.isNew).toBe(false);
  });
});

describe("vote token", () => {
  const { env } = makeEnv();

  test("issue then read round-trips the candidate id", async () => {
    const token = await issueVoteToken("candidate-03", env);
    const request = makeRequest("/", { cookies: { [VOTE_COOKIE]: token } });
    expect(await readVotedCandidateId(request, env)).toBe("candidate-03");
  });

  test("returns null without a cookie, and for a cookie signed elsewhere", async () => {
    expect(await readVotedCandidateId(makeRequest("/"), env)).toBeNull();

    const foreign = await issueVoteToken("candidate-03", makeEnv({ COOKIE_SECRET: "other" }).env);
    const request = makeRequest("/", { cookies: { [VOTE_COOKIE]: foreign } });
    expect(await readVotedCandidateId(request, env)).toBeNull();
  });
});

describe("getVoterStatus", () => {
  const { env } = makeEnv();

  test("answers from the cookie without touching D1", async () => {
    const token = await issueVoteToken("candidate-02", env);
    const request = makeRequest("/", { cookies: { [VOTE_COOKIE]: token } });
    const identity = await resolveIdentity(request, env);

    expect(await getVoterStatus(request, env, identity)).toEqual({
      hasVoted: true,
      candidateId: "candidate-02",
      reason: "cookie",
    });
    expect(dbState.calls.findExistingVote).toBe(0);
  });

  test("skips the query entirely for a brand-new voter", async () => {
    // A just-minted voter id cannot have a row, so no D1 read is needed. This
    // used to additionally require the request to have no resolvable IP,
    // because the lookup also matched ip_hash — now every first-time visitor
    // costs zero reads, IP or not.
    const request = makeRequest("/", { ip: "9.9.9.9" });
    const identity = await resolveIdentity(request, env);

    expect(await getVoterStatus(request, env, identity)).toEqual({
      hasVoted: false,
      candidateId: null,
      reason: "none",
    });
    expect(dbState.calls.findExistingVote).toBe(0);
  });

  test("two first-time voters on ONE IP both read as not-voted", async () => {
    // The status-level half of the CGNAT fix. Previously the second device
    // behind a shared address matched the first one's row on ip_hash and was
    // told it had already voted.
    dbState.existingVote = { candidateId: "candidate-05", matchedOn: "cookie" };
    const SHARED_IP = "198.51.100.42";

    for (const voter of ["phone", "laptop"]) {
      const request = makeRequest("/", { ip: SHARED_IP });
      const identity = await resolveIdentity(request, env);
      const status = await getVoterStatus(request, env, identity);

      expect(status.hasVoted).toBe(false);
      expect(`${voter}: no D1 read`).toBe(`${voter}: no D1 read`);
    }
    expect(dbState.calls.findExistingVote).toBe(0);
  });

  test("falls back to D1 for a known voter whose vote cookie is gone", async () => {
    dbState.existingVote = { candidateId: "candidate-05", matchedOn: "cookie" };
    const request = makeRequest("/", {
      ip: "9.9.9.9",
      cookies: { [VOTER_COOKIE]: "returning-voter" },
    });
    const identity = await resolveIdentity(request, env);

    expect(await getVoterStatus(request, env, identity)).toEqual({
      hasVoted: true,
      candidateId: "candidate-05",
      reason: "cookie",
    });
    expect(dbState.calls.findExistingVote).toBe(1);
  });

  test("reports not-voted when D1 has no row either", async () => {
    dbState.existingVote = null;
    const request = makeRequest("/", {
      ip: "9.9.9.9",
      cookies: { [VOTER_COOKIE]: "returning-voter" },
    });
    const identity = await resolveIdentity(request, env);

    expect(await getVoterStatus(request, env, identity)).toEqual({
      hasVoted: false,
      candidateId: null,
      reason: "none",
    });
    expect(dbState.calls.findExistingVote).toBe(1);
  });

  test("an invalid vote cookie falls through to the D1 lookup", async () => {
    dbState.existingVote = { candidateId: "candidate-01", matchedOn: "cookie" };
    const request = makeRequest("/", {
      ip: "9.9.9.9",
      cookies: { [VOTER_COOKIE]: "returning-voter", [VOTE_COOKIE]: "forged.token" },
    });
    const identity = await resolveIdentity(request, env);

    const status = await getVoterStatus(request, env, identity);
    expect(status.hasVoted).toBe(true);
    expect(dbState.calls.findExistingVote).toBe(1);
  });
});

describe("cookieAttributes", () => {
  test("sets secure over https and clears it over http", () => {
    // Dropping `secure` on http is what keeps cookies working on localhost.
    expect(cookieAttributes(new Request("https://vote.test/")).secure).toBe(true);
    expect(cookieAttributes(new Request("http://localhost:4321/")).secure).toBe(false);
  });

  test("is httpOnly, root-scoped and long-lived", () => {
    const attrs = cookieAttributes(new Request("https://vote.test/"));
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.path).toBe("/");
    expect(attrs.maxAge).toBe(60 * 60 * 24 * 365);
  });
});
