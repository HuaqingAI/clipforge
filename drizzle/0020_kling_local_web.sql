CREATE TABLE `kling_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`state` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `kling_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `kling_job_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`work_key` text NOT NULL,
	`import_state` text DEFAULT 'pending' NOT NULL,
	`asset_id` text,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `kling_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kling_outputs_work_unique` ON `kling_job_outputs` (`job_id`,`work_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `kling_outputs_asset_unique` ON `kling_job_outputs` (`asset_id`) WHERE asset_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `kling_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`principal_key` text NOT NULL,
	`region` text NOT NULL,
	`client_request_id` text NOT NULL,
	`project_id` text NOT NULL,
	`script_id` text NOT NULL,
	`shot_id` integer NOT NULL,
	`remote_generation_id` text,
	`submission_state` text NOT NULL,
	`remote_state` text DEFAULT 'not_started' NOT NULL,
	`import_state` text DEFAULT 'not_ready' NOT NULL,
	`needs_confirmation` integer DEFAULT false NOT NULL,
	`auto_query_paused` integer DEFAULT false NOT NULL,
	`dismissed_at` integer,
	`next_query_at` integer,
	`lease_owner` text,
	`lease_expires_at` integer,
	`revision` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `kling_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kling_jobs_request_unique` ON `kling_jobs` (`profile_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `kling_jobs_remote_unique` ON `kling_jobs` (`region`,`principal_key`,`remote_generation_id`) WHERE remote_generation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `kling_jobs_project_idx` ON `kling_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `kling_jobs_poll_idx` ON `kling_jobs` (`next_query_at`);--> statement-breakpoint
CREATE TABLE `kling_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_token` integer DEFAULT 0 NOT NULL,
	`lease_child_pid` integer
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `source_script_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_shot_key` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_revision` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `derived_from_asset_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_keyframe_url` text;