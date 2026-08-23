import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import { eq, count, desc, asc } from "drizzle-orm";
import type { Candidate, CandidateResult, ResultsPayload } from "@avs/shared";

import { candidates, votes } from "./schema";

export * as schema from "./schema";

/** Call once per request with the D1 binding: `const db = createDb(env.DB)`. */
export function createDb(d1: AnyD1Database) {
  return drizzle(d1);
}

export type Database = ReturnType<typeof createDb>;

// Candidate rows already come back camelCased from Drizzle (imageUrl, sortOrder),
// so there's no manual row-mapping step here the way there was against raw D1.

export async function listCandidates(db: Database): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: candidates.id,
      name: candidates.name,
      imageUrl: candidates.imageUrl,
      sortOrder: candidates.sortOrder,
    })
    .from(candidates)
    .orderBy(asc(candidates.sortOrder), asc(candidates.name));

  return rows;
}

/**
 * Looks for an existing vote by either identifier. This is the fallback path used
 * when the signed vote cookie is missing (cleared, private window, new device).
 *
 * B's raw SQL does this as one query with `ORDER BY CASE WHEN voter_id = ?1 THEN 0
 * ELSE 1 END` to prefer a voter_id match. Drizzle's query builder has no clean
 * equivalent to an inline CASE in ORDER BY, so this is two sequential queries
 * instead — voter_id first, ip_hash only if that misses. The extra round trip
 * only happens on this already-rare fallback path.
 */
export async function findExistingVote(
  db: Database,
  voterId: string,
  ipHash: string,
): Promise<{ candidateId: string; matchedOn: "cookie" | "ip" } | null> {
  const byVoterId = await db
    .select({ candidateId: votes.candidateId })
    .from(votes)
    .where(eq(votes.voterId, voterId))
    .limit(1);

  if (byVoterId[0]) {
    return { candidateId: byVoterId[0].candidateId, matchedOn: "cookie" };
  }

  const byIpHash = await db
    .select({ candidateId: votes.candidateId })
    .from(votes)
    .where(eq(votes.ipHash, ipHash))
    .limit(1);

  if (byIpHash[0]) {
    return { candidateId: byIpHash[0].candidateId, matchedOn: "ip" };
  }

  return null;
}

export interface RecordVoteInput {
  id: string;
  candidateId: string;
  voterId: string;
  ipHash: string;
  userAgent: string | null;
}

export type RecordVoteOutcome =
  | { status: "recorded" }
  | { status: "duplicate"; candidateId: string };

/**
 * Inserts the vote, relying on the UNIQUE indexes on voter_id and ip_hash rather
 * than a read-then-write. onConflictDoNothing() covers only uniqueness, so a bad
 * candidate_id still raises a foreign-key error instead of being mistaken for a
 * duplicate.
 *
 * Uses .returning() rather than checking a rows-affected count on the insert
 * result — that keeps this correct regardless of exactly how the installed
 * drizzle-orm/d1 version shapes its result metadata. An empty returned array
 * means the UNIQUE constraint silently absorbed the insert.
 */
export async function recordVote(db: Database, input: RecordVoteInput): Promise<RecordVoteOutcome> {
  const inserted = await db
    .insert(votes)
    .values({
      id: input.id,
      candidateId: input.candidateId,
      voterId: input.voterId,
      ipHash: input.ipHash,
      userAgent: input.userAgent,
    })
    .onConflictDoNothing()
    .returning({ id: votes.id });

  if (inserted.length > 0) return { status: "recorded" };

  const existing = await findExistingVote(db, input.voterId, input.ipHash);
  return { status: "duplicate", candidateId: existing?.candidateId ?? input.candidateId };
}

/**
 * The one query the results page is built on. leftJoin so candidates with zero
 * votes still appear.
 */
export async function aggregateResults(db: Database, ttlSeconds: number): Promise<ResultsPayload> {
  const rows = await db
    .select({
      id: candidates.id,
      name: candidates.name,
      imageUrl: candidates.imageUrl,
      sortOrder: candidates.sortOrder,
      votes: count(votes.id),
    })
    .from(candidates)
    .leftJoin(votes, eq(votes.candidateId, candidates.id))
    .groupBy(candidates.id, candidates.name, candidates.imageUrl, candidates.sortOrder)
    .orderBy(desc(count(votes.id)), asc(candidates.sortOrder), asc(candidates.name));

  const totalVotes = rows.reduce((sum, row) => sum + row.votes, 0);

  const results: CandidateResult[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    imageUrl: row.imageUrl,
    sortOrder: row.sortOrder,
    votes: row.votes,
    percentage: totalVotes === 0 ? 0 : Math.round((row.votes / totalVotes) * 1000) / 10,
  }));

  const generatedAt = Date.now();

  return {
    candidates: results,
    totalVotes,
    generatedAt,
    staleAt: generatedAt + ttlSeconds * 1000,
    ttlSeconds,
  };
}