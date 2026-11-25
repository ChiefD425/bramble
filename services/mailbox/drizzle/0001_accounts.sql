CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`paid_through` integer NOT NULL,
	`frozen` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_key_hash_unique` ON `accounts` (`key_hash`);--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `account_id` text REFERENCES accounts(id);--> statement-breakpoint
CREATE INDEX `mailboxes_account` ON `mailboxes` (`account_id`);