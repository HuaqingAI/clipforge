CREATE TABLE `generation_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `client_request_id` text NOT NULL,
  `request_hash` text NOT NULL,
  `kind` text NOT NULL,
  `label` text,
  `cancel_requested` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_run_request_unique` ON `generation_runs` (`project_id`, `client_request_id`);
--> statement-breakpoint
CREATE TABLE `generation_items` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `generation_runs`(`id`) ON DELETE CASCADE,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL,
  `script_id` text,
  `shot_id` integer,
  `status` text DEFAULT 'queued' NOT NULL,
  `stage` text DEFAULT 'queued' NOT NULL,
  `payload` text NOT NULL,
  `checkpoint` text,
  `result` text,
  `error` text,
  `error_code` text,
  `lease_owner` text,
  `lease_expires_at` integer,
  `next_run_at` integer NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `last_dispatched_at` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `generation_items_queue` ON `generation_items` (`status`, `next_run_at`);
--> statement-breakpoint
CREATE INDEX `generation_items_project` ON `generation_items` (`project_id`, `run_id`);
--> statement-breakpoint
ALTER TABLE `ai_tasks` ADD `asset_id` text;
--> statement-breakpoint
ALTER TABLE `ai_tasks` ADD `import_state` text DEFAULT 'pending' NOT NULL;
