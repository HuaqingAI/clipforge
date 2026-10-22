import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { klingProfiles } from "./profile-schema";
import type { KlingVideoModelDescriptor } from "./types";
import type { KlingSubmissionState, KlingRemoteState, KlingImportState, KlingCliDiagnostics } from "./job-types";
import type { Shot } from "@/lib/db/schema";

export interface KlingInputSnapshot {
  role: "image" | "tailImage";
  sourceUrl: string;
  path: string;
  hash: string;
  /** Original source bytes when normalization changes the uploaded snapshot. */
  sourceHash?: string;
  size: number;
}
export interface KlingJobData {
  scriptRevision: string;
  shotKey: string;
  expectedSelectedAssetId: string | null;
  payloadHash: string;
  requestHash: string;
  model: KlingVideoModelDescriptor;
  prompt: string;
  /** Server-owned validation version and source shot; optional for older persisted jobs. */
  videoPromptAudit?: { version: number; sourceShot: Shot };
  options: Record<string, string | number | boolean>;
  inputs: KlingInputSnapshot[];
  args: string[];
  accountLabel?: string;
  cliVersion: string;
  adapterVersion: string;
  authorizedBootId: string;
  authorizedUntil: number;
  authorizationEpoch: number;
  /** Server-owned FilmRun linkage; browser single-shot requests cannot supply these fields. */
  filmRunId?: string;
  filmShotId?: string;
  filmAuthorizationEpoch?: number;
  billingAcknowledgedAt: number;
  dispatchStartedAt?: number;
  acknowledgedAt?: number;
  aiTaskId?: string;
  lastCheckedAt?: number;
  rawStatus?: string;
  queryAttempts: number;
  /** Deletion retains the paid-task audit while preventing recovery or reimport. */
  deletedAt?: number;
  deletePendingFiles?: string[];
  /** Exact output ids awaiting cleanup after a revoked worker stops writing. */
  deletePendingOutputIds?: string[];
  blockedReason?: string;
  error?: { code: string; message: string; retryable: boolean };
  cliDiagnostics?: KlingCliDiagnostics;
  bindingMethod?: "receipt" | "cli" | "manual";
  bindingConfirmedAt?: number;
  bindingCandidateHash?: string;
}
export interface KlingOutputData {
  url: string;
  urlObtainedAt: number;
  providerWorkId: string;
  localPath?: string;
  filePath?: string;
  thumbnailUrl?: string;
  sourceKeyframeUrl?: string;
  byteSize?: number;
  contentHash?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  selectionOutcome?: "selected" | "kept_as_alternative" | "detached";
  error?: { code: string; message: string; retryable: boolean };
}
export const klingJobs = sqliteTable("kling_jobs", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => klingProfiles.id),
  principalKey: text("principal_key").notNull(),
  region: text("region").notNull(),
  clientRequestId: text("client_request_id").notNull(),
  projectId: text("project_id").notNull(),
  scriptId: text("script_id").notNull(),
  shotId: integer("shot_id").notNull(),
  remoteGenerationId: text("remote_generation_id"),
  submissionState: text("submission_state").$type<KlingSubmissionState>().notNull(),
  remoteState: text("remote_state").$type<KlingRemoteState>().notNull().default("not_started"),
  importState: text("import_state").$type<KlingImportState>().notNull().default("not_ready"),
  needsConfirmation: integer("needs_confirmation", { mode: "boolean" }).notNull().default(false),
  autoQueryPaused: integer("auto_query_paused", { mode: "boolean" }).notNull().default(false),
  dismissedAt: integer("dismissed_at"),
  nextQueryAt: integer("next_query_at"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  revision: integer("revision").notNull().default(0),
  data: text("data", { mode: "json" }).$type<KlingJobData>().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("kling_jobs_request_unique").on(table.profileId, table.clientRequestId),
  uniqueIndex("kling_jobs_remote_unique").on(table.region, table.principalKey, table.remoteGenerationId).where(sql.raw("remote_generation_id IS NOT NULL")),
  index("kling_jobs_project_idx").on(table.projectId, table.createdAt),
  index("kling_jobs_poll_idx").on(table.nextQueryAt),
]);
export const klingJobOutputs = sqliteTable("kling_job_outputs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => klingJobs.id),
  workKey: text("work_key").notNull(),
  importState: text("import_state").$type<"pending" | "downloading" | "validating" | "imported" | "failed">().notNull().default("pending"),
  assetId: text("asset_id"),
  data: text("data", { mode: "json" }).$type<KlingOutputData>().notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("kling_outputs_work_unique").on(table.jobId, table.workKey),
  uniqueIndex("kling_outputs_asset_unique").on(table.assetId).where(sql.raw("asset_id IS NOT NULL")),
]);
export type KlingJob = typeof klingJobs.$inferSelect;
export type KlingJobOutput = typeof klingJobOutputs.$inferSelect;
