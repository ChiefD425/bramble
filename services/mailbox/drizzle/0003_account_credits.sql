CREATE TABLE `account_credits` (
	`op` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`days` integer NOT NULL,
	`token` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
