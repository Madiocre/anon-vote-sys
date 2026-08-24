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

/**
 * Why a voter is not allowed to vote again.
 *
 * `"ip"` was removed along with IP-based dedup — a public IPv4 is not one
 * person, so matching on it locked out everyone behind a shared address. See
 * docs/vote-integrity.md. Identity now rests on the `vid` cookie alone, so the
 * only reasons left are "we have a record for this voter" and "we do not".
 */
export type VoteBlockReason = "cookie" | "none";

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
  /**
   * `verification_failed` covers both halves of the Turnstile check — a POST
   * that carried no token at all, and one whose token the siteverify endpoint
   * rejected. Kept distinct from `invalid_request` so the ballot can say "the
   * check didn't pass, try again" rather than "no candidate was selected".
   */
  error:
    | "already_voted"
    | "unknown_candidate"
    | "invalid_request"
    | "verification_failed"
    | "rate_limited"
    | "server_error";
  message: string;
  /** Present when the failure is `already_voted` and we know the earlier pick. */
  candidateId?: string;
}

export type VoteResponse = VoteSuccess | VoteFailure;