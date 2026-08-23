export interface Candidate {
  id: string;
  name: string;
  imageUrl: string;
  sortOrder: number;
}

export interface CandidateResult extends Candidate {
  votes: number;
  /** Share of the total, 0-100, rounded to one decimal. */
  percentage: number;
}

export interface ResultsPayload {
  candidates: CandidateResult[];
  totalVotes: number;
  /** Unix ms at which these numbers were read out of D1. */
  generatedAt: number;
  /** Unix ms at which the edge cache entry expires and D1 is read again. */
  staleAt: number;
  ttlSeconds: number;
}

/** Why a voter is not allowed to vote again. */
export type VoteBlockReason = "cookie" | "ip" | "none";

export interface VoterStatus {
  hasVoted: boolean;
  /** Which candidate they picked, when we can tell. */
  candidateId: string | null;
  reason: VoteBlockReason;
}

export interface VoteSuccess {
  ok: true;
  candidateId: string;
}

export interface VoteFailure {
  ok: false;
  error: "already_voted" | "unknown_candidate" | "invalid_request" | "server_error";
  message: string;
  /** Present when the failure is `already_voted` and we know the earlier pick. */
  candidateId?: string;
}

export type VoteResponse = VoteSuccess | VoteFailure;