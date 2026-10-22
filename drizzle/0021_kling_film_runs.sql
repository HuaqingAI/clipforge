CREATE TABLE `kling_film_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`principal_key` text NOT NULL,
	`client_request_id` text,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `kling_films_project_idx` ON `kling_film_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `kling_films_request_unique` ON `kling_film_runs` (`profile_id`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `kling_film_shots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`shot_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`status` text NOT NULL,
	`job_id` text,
	`asset_id` text,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `kling_film_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kling_film_shots_ordinal_unique` ON `kling_film_shots` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `kling_film_shots_job_unique` ON `kling_film_shots` (`job_id`);