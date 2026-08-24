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
 * Looks for an existing vote by voter id. This is the fallback path used when
 * the signed vote cookie is missing but the `vid` cookie survived — an expired
 * vote token, or a partial cookie clear.
 *
 * It used to also match on ip_hash, which is what made a second device on one
 * network read as a duplicate. That lookup is gone: a public IPv4 is not one
 * person (docs/vote-integrity.md). ip_hash is still recorded, but only as a
 * forensic signal — nothing on the request path reads it.
 *
 * The consequence, accepted deliberately: clearing the `vid` cookie yields a new
 * identity and therefore a new vote. Preventing that needs an identity layer the
 * project has ruled out.
 */
export async function findExistingVote(
  db: Database,
  voterId: string,
): Promise<{ candidateId: string; matchedOn: "cookie" } | null> {
  const byVoterId = await db
    .select({ candidateId: votes.candidateId })
    .from(votes)
    .where(eq(votes.voterId, voterId))
    .limit(1);

  if (byVoterId[0]) {
    return { candidateId: byVoterId[0].candidateId, matchedOn: "cookie" };
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

  // Only voter_id is unique now, so a swallowed insert can only mean this voter
  // already has a row — look it up to report which candidate they actually got.
  const existing = await findExistingVote(db, input.voterId);
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