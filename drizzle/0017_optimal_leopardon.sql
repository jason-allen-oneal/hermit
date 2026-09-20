CREATE TABLE `review_card_write_attempts` (
	`attempt_token` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`rendered_revision` integer NOT NULL,
	`claim_token` text,
	`claim_expires_at` text,
	`next_attempt_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_review_card_write_attempts_due` ON `review_card_write_attempts` (`guild_id`,`next_attempt_at`,`claim_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_review_card_write_attempts_case` ON `review_card_write_attempts` (`case_id`);--> statement-breakpoint
ALTER TABLE `review_cases` ADD `delivery_attempt_state` text DEFAULT 'legacy_unknown' NOT NULL;