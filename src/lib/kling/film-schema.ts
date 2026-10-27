import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Shot, ScriptCharacter } from "@/lib/db/schema";
import type { KlingInputSnapshot } from "./job-schema";
import type { KlingVideoModelDescriptor } from "./types";
import type { KlingFilmOutputSettings, KlingFilmStatus, KlingFilmShotStatus } from "./film-types";
import type { VideoPromptSettings } from "@/lib/shot-video-prompt";
import type { ProjectCreativeProfile } from "@/lib/creative-profiles";
import type { TideweCopyDocument } from "@/lib/tidewe/types";

export interface KlingFilmData {
  scriptRevision: string;
  scriptSnapshot: { shots: Shot[]; characters?: ScriptCharacter[]; copyDocument?: TideweCopyDocument | null };
  model: KlingVideoModelDescriptor;
  output: KlingFilmOutputSettings;
  promptSettings?: VideoPromptSettings;
  projectPromptRevision?: string;
  /** Immutable creative policy used to compile this plan. */
  creativeProfile?: ProjectCreativeProfile;
  creativeConfigRevision?: number;
  planHash: string;
  expiresAt: number;
  reuseExistingVideos: boolean;
  warnings: string[];
  stage: string;
  error?: string;
  authorizationBootId?: string;
  authorizationEpoch: number;
  authorizedUntil?: number;
  compositionId?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  quality?: { width: number; height: number; duration: number; hasAudio: boolean };
}
export interface KlingFilmShotData {
  shot: Shot;
  source: "reuse" | "generate";
  prompt: string;
  generationDuration?: number;
  options: Record<string, string | number | boolean>;
  keyframeUrl?: string;
  missingKeyframe: boolean;
  inputs: KlingInputSnapshot[];
  baselineAssetId: string | null;
  sourceFileHash?: string;
  sourceFilePath?: string;
  videoUrl?: string;
  error?: string;
  attempt: number;
}
export const klingFilmRuns = sqliteTable("kling_film_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(), scriptId: text("script_id").notNull(),
  profileId: text("profile_id").notNull(), principalKey: text("principal_key").notNull(),
  clientRequestId: text("client_request_id"),
  status: text("status").$type<KlingFilmStatus>().notNull(),
  data: text("data", { mode: "json" }).$type<KlingFilmData>().notNull(),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("kling_films_project_idx").on(table.projectId, table.createdAt),
  uniqueIndex("kling_films_request_unique").on(table.profileId, table.clientRequestId)]);
export const klingFilmShots = sqliteTable("kling_film_shots", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => klingFilmRuns.id),
  shotId: integer("shot_id").notNull(), ordinal: integer("ordinal").notNull(),
  status: text("status").$type<KlingFilmShotStatus>().notNull(),
  jobId: text("job_id"), assetId: text("asset_id"),
  data: text("data", { mode: "json" }).$type<KlingFilmShotData>().notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("kling_film_shots_ordinal_unique").on(table.runId, table.ordinal),
  uniqueIndex("kling_film_shots_job_unique").on(table.jobId)]);
export type KlingFilmRun = typeof klingFilmRuns.$inferSelect;
export type KlingFilmShot = typeof klingFilmShots.$inferSelect;
