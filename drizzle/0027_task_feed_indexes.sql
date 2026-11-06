ALTER TABLE `ai_tasks` ADD `generation_released_at` integer;
--> statement-breakpoint
CREATE INDEX `generation_items_task_summary` ON `generation_items` (`run_id`, `created_at`, `id`, `status`, `stage`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `ai_tasks_status_import` ON `ai_tasks` (`status`, `import_state`);
