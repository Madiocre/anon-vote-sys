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
    id: text("id").primaryKey(),
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

    // ip_hash is deliberately NOT unique. It was, and that made a public IPv4
    // address mean "one person" — which it is not. Carrier-grade NAT puts
    // hundreds to thousands of mobile subscribers behind a single address, so a
    // UNIQUE index here let the first voter on a carrier gateway lock out
    // everyone behind it. See docs/vote-integrity.md for why no per-IP quota
    // fixes this either.
    //
    // The column and index are kept because ip_hash is still recorded as a
    // FORENSIC signal: after the fact, an ip_hash with thousands of votes is
    // either a carrier gateway or a farm, and the two are distinguishable by
    // how they spread across candidates and time. The index is what makes those
    // grouping queries cheap. Nothing reads it on the request path.
    index("idx_votes_ip_hash").on(t.ipHash),
    // Supports the GROUP BY in aggregateResults.
    index("idx_votes_candidate").on(t.candidateId),
  ],
);