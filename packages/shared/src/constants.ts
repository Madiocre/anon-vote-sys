/** Cookie holding the anonymous voter UUID. Long-lived, httpOnly. */
export const VOTER_COOKIE = "vid";

/** Cookie holding the HMAC-signed proof-of-vote. Lets us skip D1 entirely on repeat visits. */
export const VOTE_COOKIE = "vote";

/** One year, in seconds. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** How long the aggregated results stay cached at the edge before D1 is consulted again. */
export const DEFAULT_RESULTS_TTL_SECONDS = 600;

/** Routes the UI links between. Kept here so the API and the pages cannot drift apart. */
export const ROUTES = {
  vote: "/",
  thanks: "/thanks",
  results: "/results",
} as const;