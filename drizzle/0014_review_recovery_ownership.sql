ALTER TABLE `review_cases` ADD `delivery_nonce` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `delivery_claim_token` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `delivery_claim_expires_at` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `receipt_claim_token` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `receipt_claim_expires_at` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `receipt_next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `receipt_history_before` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `card_sync_next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `review_cases` ADD `card_sync_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_review_cases_receipt_recovery` ON `review_cases` (`guild_id`,`delivery_status`,`receipt_next_attempt_at`,`receipt_claim_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_review_cases_card_sync_due` ON `review_cases` (`card_sync_next_attempt_at`,`card_revision`,`synced_card_revision`);