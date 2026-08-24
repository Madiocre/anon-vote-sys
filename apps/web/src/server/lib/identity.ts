import { createDb, findExistingVote } from "@avs/db";
import { COOKIE_MAX_AGE, VOTE_COOKIE, VOTER_COOKIE, type VoterStatus } from "@avs/shared";

import { requireSecret, type Env } from "../env.ts";
import { sha256Hex, signToken, verifyToken } from "./crypto.ts";

/** Payload inside the signed vote cookie. Short keys — this rides on every request. */
interface VoteTokenPayload {
  /** candidate id */
  c: string;
  /** issued at, unix seconds */
  t: number;
}

export interface VoterIdentity {
  voterId: string;
  ipHash: string;
  /** True when this voter had no `vid` cookie and we minted one. */
  isNew: boolean;
}

/** Framework-neutral cookie read — usable from Hono and from Astro pages alike. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Cloudflare sets CF-Connecting-IP on every request that reaches the Worker. The
 * other headers are only there for local dev and proxies, and are trusted no
 * further than that — a spoofed value costs an attacker one extra vote, which is
 * the accepted threat model for a public poll.
 */
export function resolveClientIp(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  if (direct) return direct.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}

/**
 * Salted digest of the client IP. When no IP is available — `astro dev` over
 * localhost, for instance — this falls back to the voter id so the whole local
 * machine does not collapse onto one shared hash and lock itself out after the
 * first vote. In production CF-Connecting-IP is always present.
 */
export async function computeIpHash(request: Request, voterId: string, env: Env): Promise<string> {
  const salt = requireSecret(env, "VOTE_SALT");
  const ip = resolveClientIp(request);
  return sha256Hex(ip ? `ip:${salt}:${ip}` : `fallback:${salt}:${voterId}`);
}

export async function resolveIdentity(request: Request, env: Env): Promise<VoterIdentity> {
  const existing = readCookie(request, VOTER_COOKIE);
  const voterId = existing ?? crypto.randomUUID();
  const ipHash = await computeIpHash(request, voterId, env);

  return { voterId, ipHash, isNew: !existing };
}

export async function issueVoteToken(candidateId: string, env: Env): Promise<string> {
  const payload: VoteTokenPayload = { c: candidateId, t: Math.floor(Date.now() / 1000) };
  return signToken(payload, requireSecret(env, "COOKIE_SECRET"));
}

/**
 * Cookie-only read of the recorded pick — never touches D1. Used by the thank-you
 * page, which has nothing useful to say to someone without the cookie anyway.
 */
export async function readVotedCandidateId(request: Request, env: Env): Promise<string | null> {
  const token = await verifyToken<VoteTokenPayload>(
    readCookie(request, VOTE_COOKIE),
    requireSecret(env, "COOKIE_SECRET"),
  );
  return token?.c ?? null;
}

/**
 * The read that keeps D1 quiet. A returning voter carrying a valid signed cookie
 * is answered from the cookie alone; only voters without one (cleared cookies,
 * new device, private window) cost a single indexed lookup.
 */
export async function getVoterStatus(
  request: Request,
  env: Env,
  identity: VoterIdentity,
): Promise<VoterStatus> {
  const token = await verifyToken<VoteTokenPayload>(
    readCookie(request, VOTE_COOKIE),
    requireSecret(env, "COOKIE_SECRET"),
  );

  if (token?.c) {
    return { hasVoted: true, candidateId: token.c, reason: "cookie" };
  }

  // A just-minted voter id cannot have a row yet, so skip the query entirely.
  //
  // This used to also require `resolveClientIp(request) === null`, because the
  // lookup matched on ip_hash too and a new voter could still collide with an
  // existing row via a shared address. Now that the lookup is voter_id only,
  // `isNew` alone is sufficient — which also means every first-time visitor
  // costs zero D1 reads instead of one.
  if (identity.isNew) {
    return { hasVoted: false, candidateId: null, reason: "none" };
  }

  const existing = await findExistingVote(createDb(env.DB), identity.voterId);
  if (!existing) return { hasVoted: false, candidateId: null, reason: "none" };

  return { hasVoted: true, candidateId: existing.candidateId, reason: existing.matchedOn };
}

export interface CookieAttributes {
  path: string;
  maxAge: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * `secure` is derived from the request scheme so cookies are not silently
 * dropped when developing over plain http on localhost.
 */
export function cookieAttributes(request: Request): CookieAttributes {
  return {
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
  };
}
