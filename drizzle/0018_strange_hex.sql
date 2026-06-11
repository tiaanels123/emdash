CREATE TABLE `task_projects` (
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`task_id`, `project_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `organization_id` text DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_task_projects_project_id` ON `task_projects` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_organization_id` ON `tasks` (`organization_id`);