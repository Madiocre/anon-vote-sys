CREATE TABLE `candidates` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`image_url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`id` integer PRIMARY KEY,
	`candidate_id` text NOT NULL,
	`voter_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_votes_candidate_id_candidates_id_fk` FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_candidates_sort` ON `candidates` (`sort_order`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_votes_voter_id` ON `votes` (`voter_id`);