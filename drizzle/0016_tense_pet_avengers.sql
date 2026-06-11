CREATE TABLE `organization_settings` (
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`organization_id`, `key`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `organization_id` text DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_organizations_sort_order` ON `organizations` (`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_projects_organization_id` ON `projects` (`organization_id`);