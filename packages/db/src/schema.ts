// packages/db/src/schema.ts
//
// Table shape ported from anonymous-public-votes' migrations/0001_init.sql.
// Column names stay snake_case in SQLite; JS-side property names are camelCase,
// which is what lets query results come back already camelCased with no manual
// row-mapping step.
//
// Targets drizzle-orm@rc (v1). The third-argument extraConfig callback returns
// an array of constraint builders, not an object — the older `{ name: index(...) }`
// shape is deprecated in v1. Names still come from the string passed into
// index()/uniqueIndex() itself, not from an object key, so nothing here loses
// its name by dropping the object wrapper.

import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const candidates = sqliteTable(
  "candidates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    imageUrl: text("image_url").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),

    /**
     * Running tally, incremented by recordVote() as each vote lands.
     *
     * This exists because D1 bills rows *scanned*, not returned. Counting votes
     * with a LEFT JOIN + GROUP BY walked every row in `votes` on every results
     * computation — ~500k rows at full scale, against a 5M/day free budget that
     * the per-colo cache multiplies rather than divides. Reading a column costs
     * 20 rows instead.
     *
     * It is a cache, not the source of truth: `votes` still carries
     * `candidate_id`, so this is always recomputable. See docs/vote-integrity.md.
     */
    voteCount: integer("vote_count").notNull().default(0),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Supports listCandidates' ORDER BY sort_order, name.
    index("idx_candidates_sort").on(t.sortOrder, t.id),
  ],
);

export const votes = sqliteTable(
  "votes",
  {
    /**
     * INTEGER PRIMARY KEY, which SQLite aliases to the rowid — so it needs no
     * index of its own.
     *
     * This was a `text` uuid, and that quietly cost a write on every vote:
     * any non-INTEGER primary key gets its own `sqlite_autoindex_*` B-tree. The
     * uuid earned nothing for it — grep the package and `votes.id` appears only
     * in `.returning()` (to detect whether an insert landed) and `count()`.
     * Never a lookup key, never exposed to a client.
     *
     * Deliberately NOT `{ autoIncrement: true }`: AUTOINCREMENT maintains a
     * `sqlite_sequence` row, which would add back the write this removes.
     */
    id: integer("id").primaryKey(),

    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    voterId: text("voter_id").notNull(),
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // voter_id is THE dedup mechanism. Enforcing it as a constraint rather than
    // a SELECT-then-INSERT means two concurrent requests from one voter cannot
    // both slip through: the loser gets a UNIQUE violation, which recordVote()
    // translates into "duplicate".
    uniqueIndex("idx_votes_voter_id").on(t.voterId),

    // This is the ONLY index on votes, on purpose. Every index costs a write on
    // every vote — D1 bills each index update as a row written — and at 100k
    // writes/day on the free plan that is the difference between ~20,000 and
    // ~33,000 votes per day.
    //
    // Two were removed:
    //
    //   idx_votes_ip_hash    — ip_hash is forensic only; nothing reads it on the
    //                          request path. Grouping by it after the fact scans
    //                          the table once, which costs ~500k of a 5M daily
    //                          read budget. Affordable as a one-off; not worth a
    //                          write on every vote.
    //
    //   idx_votes_candidate  — existed for the LEFT JOIN in aggregateResults.
    //                          That join is gone: results now read
    //                          candidates.vote_count. Nothing joins votes any
    //                          more except a deliberate recount.
    //
    // Both columns are still stored. Only their indexes are gone.
  ],
);