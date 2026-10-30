import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const generationRuns = sqliteTable("generation_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  kind: text("kind").notNull(),
  label: text("label"),
  cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
  // Keep the request key and checkpoints after hiding a finished run so a lost
  // acknowledgement can never create the same paid work again.
  deletedAt: integer("deleted_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("generation_run_request_unique").on(t.projectId, t.clientRequestId)]);

export const generationItems = sqliteTable("generation_items", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => generationRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull(),
  kind: text("kind").notNull(),
  scriptId: text("script_id"),
  shotId: integer("shot_id"),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  payload: text("payload").notNull(),
  checkpoint: text("checkpoint"),
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
  error: text("error"),
  errorCode: text("error_code"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  nextRunAt: integer("next_run_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastDispatchedAt: integer("last_dispatched_at").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("generation_items_queue").on(t.status, t.nextRunAt), index("generation_items_project").on(t.projectId, t.runId)]);
