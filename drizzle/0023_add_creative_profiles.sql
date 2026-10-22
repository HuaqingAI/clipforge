ALTER TABLE `projects` ADD `creative_profile` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `creative_profile_drafts` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `creative_config_revision` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `scripts` ADD `creative_profile_snapshot` text;
