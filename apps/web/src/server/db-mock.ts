/**
 * The single `@avs/db` mock for the whole server test suite.
 *
 * This lives in one module on purpose. `mock.module()` registers globally for
 * the test *process*, not per file, and `bun test` runs every file in one
 * process — so two files each registering their own partial mock would race,
 * and whichever ran last would win. Importing this module from every test that
 * needs the database means there is exactly one registration and one piece of
 * shared, resettable state.
 *
 * Mocking at the `@avs/db` boundary rather than at the D1 binding is deliberate:
 * the binding's surface (prepare/bind/all/run) is Drizzle's problem, not ours.
 * What the server code actually depends on is these five functions.
 */

import { mock } from "bun:test";

import type { Candidate, ResultsPayload } from "@avs/shared";
import type { RecordVoteOutcome } from "@avs/db";

export const CANDIDATES: Candidate[] = [
  { id: "candidate-01", name: "Candidate One", imageUrl: "https://img.test/1.webp", sortOrder: 1 },
  { id: "candidate-02", name: "Candidate Two", imageUrl: "https://img.test/2.webp", sortOrder: 2 },
  { id: "candidate-03", name: "Candidate Three", imageUrl: "https://img.test/3.webp", sortOrder: 3 },
];

export interface DbState {
  existingVote: { candidateId: string; matchedOn: "cookie" | "ip" } | null;
  recordOutcome: RecordVoteOutcome;
  /** Set to make a call throw, for exercising app.onError. */
  throwOn: null | "listCandidates" | "aggregateResults" | "recordVote" | "findExistingVote";
  calls: {
    listCandidates: number;
    aggregateResults: number;
    findExistingVote: number;
    recordVote: number;
  };
  lastRecordedVote: unknown;
}

export const dbState: DbState = {
  existingVote: null,
  recordOutcome: { status: "recorded" },
  throwOn: null,
  calls: { listCandidates: 0, aggregateResults: 0, findExistingVote: 0, recordVote: 0 },
  lastRecordedVote: null,
};

export function resetDbState(): void {
  dbState.existingVote = null;
  dbState.recordOutcome = { status: "recorded" };
  dbState.throwOn = null;
  dbState.calls = { listCandidates: 0, aggregateResults: 0, findExistingVote: 0, recordVote: 0 };
  dbState.lastRecordedVote = null;
}

function guard(name: NonNullable<DbState["throwOn"]>): void {
  if (dbState.throwOn === name) throw new Error(`simulated D1 failure in ${name}`);
}

mock.module("@avs/db", () => ({
  // createDb only wraps the binding, so the identity function is a faithful stub.
  createDb: (d1: unknown) => d1,

  listCandidates: async (): Promise<Candidate[]> => {
    dbState.calls.listCandidates += 1;
    guard("listCandidates");
    return CANDIDATES;
  },

  aggregateResults: async (_db: unknown, ttlSeconds: number): Promise<ResultsPayload> => {
    dbState.calls.aggregateResults += 1;
    guard("aggregateResults");
    const generatedAt = Date.now();
    return {
      candidates: CANDIDATES.map((c, i) => ({ ...c, votes: 3 - i, percentage: [50, 33.3, 16.7][i]! })),
      totalVotes: 6,
      generatedAt,
      staleAt: generatedAt + ttlSeconds * 1000,
      ttlSeconds,
    };
  },

  findExistingVote: async () => {
    dbState.calls.findExistingVote += 1;
    guard("findExistingVote");
    return dbState.existingVote;
  },

  recordVote: async (_db: unknown, input: unknown): Promise<RecordVoteOutcome> => {
    dbState.calls.recordVote += 1;
    guard("recordVote");
    dbState.lastRecordedVote = input;
    return dbState.recordOutcome;
  },
}));
