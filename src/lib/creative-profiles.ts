import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION } from "@/lib/tidewe/types";
import type { TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { isValidTidewePresenterInput, snapshotTidewePresenter } from "@/lib/tidewe/presenter";

export const TIDEWE_OUTDOOR_STYLE = "tidewe_outdoor" as const;
export const TIDEWE_OUTDOOR_PROFILE_ID = "tidewe_outdoor_v1" as const;
export const TIDEWE_OUTDOOR_PROMPT_COMPILER_VERSION = TIDEWE_COMPILER_VERSION;
export type CreationType = "tidewe_outdoor";

export interface LegacyComposeSettings {
  subtitles?: boolean;
  ttsEnabled?: boolean;
  ctaEnabled?: boolean;
  productCard?: boolean;
  editorialGraphics?: boolean;
  captionPreset?: string;
  bgmDuck?: number;
  bgmVolume?: number;
  quality?: string;
  aspectRatio?: string;
  ctaText?: string;
  [key: string]: unknown;
}

export interface TideweOutdoorProfile {
  version: 1;
  id: typeof TIDEWE_OUTDOOR_PROFILE_ID;
  creationType: "tidewe_outdoor";
  styleType: "tidewe_outdoor";
  videoMode: "product_closeup" | "scene_demo";
  targetDuration: 30 | 40 | 60;
  language: "en-US";
  reviewLanguage: "zh-CN";
  market: "US";
  platform: "tiktok";
  narrativeAngle: "auto" | "scene_pain" | "choice" | "use_demo" | "long_wait" | "gift";
  speechMode: "on_camera" | "voiceover";
  presenter?: TidewePresenterSnapshot;
  corpusVersion: string;
  promptCompilerVersion: string;
  composeSnapshot: LegacyComposeSettings;
}

export type ProjectCreativeProfile = TideweOutdoorProfile;

/** Read-only marker for stored projects whose creation workflow has been removed. */
export interface ArchivedCreativeProfile {
  version: 1;
  id: "unsupported";
  creationType: "unsupported";
  styleType: string;
  videoMode: "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter";
  targetDuration: number;
  composeSnapshot: LegacyComposeSettings;
}
export type ResolvedCreativeProfile = ProjectCreativeProfile | ArchivedCreativeProfile;
export interface ProjectCreativeProfileDrafts { tidewe_outdoor?: TideweOutdoorProfile; }
export interface CreativeProfileFallback {
  styleType?: unknown;
  videoMode?: unknown;
  targetDuration?: unknown;
  composeSnapshot?: unknown;
}
export interface CreativeProfileSnapshot {
  profile: ResolvedCreativeProfile;
  creativeConfigRevision: number;
}
export interface CreativeProfileProjectContext {
  creativeProfile?: unknown;
  videoMode?: unknown;
  creativeConfigRevision?: unknown;
}
export interface CreativeProfileScriptContext {
  styleType?: unknown;
  creativeProfileSnapshot?: unknown;
}
interface CreativeProfileContext {
  projectProfile: ResolvedCreativeProfile;
  scriptProfile: ResolvedCreativeProfile;
  projectRevision: number;
  scriptRevision?: number;
}
export type CreativeProfileContextCheck = CreativeProfileContext & (
  | { ok: true }
  | { ok: false; code: "CREATIVE_PROFILE_MISMATCH" | "CREATIVE_CONFIG_STALE" }
);
export type CreativeProfileInputResult =
  | { profile: ProjectCreativeProfile; error?: never }
  | { profile?: never; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function shallowJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 80) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") output[key] = item;
    else if (Array.isArray(item)) output[key] = item.slice(0, 50);
    else if (isRecord(item)) output[key] = { ...item };
  }
  return output;
}
function sanitizeComposeSnapshot(value: unknown): LegacyComposeSettings { return shallowJsonRecord(value) ?? {}; }

export function createTideweOutdoorProfile(options: {
  targetDuration?: unknown; videoMode?: unknown; narrativeAngle?: unknown; composeSnapshot?: unknown; speechMode?: unknown; presenter?: unknown;
} = {}): TideweOutdoorProfile {
  const compose = sanitizeComposeSnapshot(options.composeSnapshot);
  const speechMode = options.speechMode === "voiceover" ? "voiceover" : "on_camera";
  const presenter = snapshotTidewePresenter(options.presenter);
  const angles = ["auto", "scene_pain", "choice", "use_demo", "long_wait", "gift"];
  return {
    version: 1, id: TIDEWE_OUTDOOR_PROFILE_ID, creationType: "tidewe_outdoor", styleType: TIDEWE_OUTDOOR_STYLE,
    videoMode: options.videoMode === "product_closeup" ? "product_closeup" : "scene_demo",
    targetDuration: options.targetDuration === 30 || options.targetDuration === 60 ? options.targetDuration : 40,
    language: "en-US", reviewLanguage: "zh-CN", market: "US", platform: "tiktok", speechMode,
    ...(presenter && { presenter }),
    narrativeAngle: angles.includes(String(options.narrativeAngle)) ? options.narrativeAngle as TideweOutdoorProfile["narrativeAngle"] : "auto",
    corpusVersion: TIDEWE_CORPUS_VERSION, promptCompilerVersion: TIDEWE_COMPILER_VERSION,
    composeSnapshot: { ...compose, ttsEnabled: speechMode === "voiceover", nativeAudio: speechMode === "on_camera", subtitles: compose.subtitles !== false, productCard: false,
      ctaEnabled: false, editorialGraphics: false, aspectRatio: "9:16" },
  };
}

function tideweSignal(value: Record<string, unknown>): boolean {
  return value.creationType === TIDEWE_OUTDOOR_STYLE || value.styleType === TIDEWE_OUTDOOR_STYLE
    || [value.id, value.profileId, value.creativeProfileId].includes(TIDEWE_OUTDOOR_PROFILE_ID);
}

export function isTideweOutdoorProfile(value: unknown): value is TideweOutdoorProfile {
  return value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID || (isRecord(value) && tideweSignal(value));
}

/** Only explicit native profiles opt in; frozen historical voiceover footage stays compatible. */
export function isTideweNativeSpeech(value: unknown): value is TideweOutdoorProfile & { speechMode: "on_camera" } {
  return isRecord(value) && isTideweOutdoorProfile(value) && value.speechMode === "on_camera";
}

export function assertSupportedTideweProfile(profile: TideweOutdoorProfile): void {
  if (profile.version !== 1 || profile.corpusVersion !== TIDEWE_CORPUS_VERSION || profile.promptCompilerVersion !== TIDEWE_COMPILER_VERSION) {
    throw new Error("Unsupported TIDEWE profile version; regenerate with the current creative profile");
  }
}

/** Only TIDEWE is accepted for new or updated creative configurations. */
export function validateCreativeProfileInput(value: unknown): CreativeProfileInputResult {
  if (value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID) return { profile: createTideweOutdoorProfile() };
  if (!isRecord(value)) return { error: "Creative profile must be an object or a known profile identifier." };
  let hasIdentity = false;
  if (value.creationType !== undefined) {
    if (value.creationType !== TIDEWE_OUTDOOR_STYLE) return { error: "Unsupported creative creationType. Only TIDEWE is available." };
    hasIdentity = true;
  }
  for (const id of [value.id, value.profileId, value.creativeProfileId].filter(item => item !== undefined && item !== null)) {
    if (id !== TIDEWE_OUTDOOR_PROFILE_ID) return { error: "Unknown creative profile identifier." };
    hasIdentity = true;
  }
  if (value.styleType !== undefined && value.styleType !== null) {
    if (value.styleType !== TIDEWE_OUTDOOR_STYLE) return { error: "Unsupported creative profile styleType." };
    hasIdentity = true;
  }
  if (!hasIdentity) return { error: "Creative profile must declare a creationType, profile identifier, or styleType." };
  if (value.version !== undefined && value.version !== 1) return { error: "Unsupported TIDEWE profile version." };
  if (value.speechMode !== undefined && value.speechMode !== "on_camera" && value.speechMode !== "voiceover") return { error: "Unsupported TIDEWE speech mode." };
  if (value.presenter != null && !isValidTidewePresenterInput(value.presenter)) return { error: "请选择有外貌描述或参考图的有效出镜主播。" };
  const profile = sanitizeCreativeProfile(value)!;
  try { assertSupportedTideweProfile(profile); } catch (error) { return { error: (error as Error).message }; }
  return { profile };
}

/** Preserve historical TIDEWE compiler/corpus metadata when reading stored snapshots. */
export function sanitizeCreativeProfile(value: unknown): ProjectCreativeProfile | undefined {
  if (value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID) return createTideweOutdoorProfile();
  if (!isRecord(value) || !tideweSignal(value)) return undefined;
  const profile = createTideweOutdoorProfile(value);
  return { ...profile, ...(typeof value.version === "number" && { version: value.version as 1 }),
    ...(typeof value.corpusVersion === "string" && { corpusVersion: value.corpusVersion }),
    ...(typeof value.promptCompilerVersion === "string" && { promptCompilerVersion: value.promptCompilerVersion }) };
}

/** Never reinterpret a removed or unknown stored creation type as a TIDEWE project. */
export function resolveCreativeProfile(value: unknown, fallback: CreativeProfileFallback = {}): ResolvedCreativeProfile {
  const tidewe = sanitizeCreativeProfile(value);
  if (tidewe) return tidewe;
  if (value == null && fallback.styleType === TIDEWE_OUTDOOR_STYLE) return createTideweOutdoorProfile(fallback);
  const stored = isRecord(value) ? value : {};
  const mode = stored.videoMode ?? fallback.videoMode;
  const duration = stored.targetDuration ?? fallback.targetDuration;
  return { version: 1, id: "unsupported", creationType: "unsupported",
    styleType: typeof stored.styleType === "string" ? stored.styleType : typeof fallback.styleType === "string" ? fallback.styleType : "",
    videoMode: mode === "graphic_montage" || mode === "scene_demo" || mode === "live_presenter" ? mode : "product_closeup",
    targetDuration: typeof duration === "number" && Number.isFinite(duration) ? duration : 30,
    composeSnapshot: sanitizeComposeSnapshot(stored.composeSnapshot ?? fallback.composeSnapshot) };
}
export function sanitizeCreativeProfileDrafts(value: unknown): ProjectCreativeProfileDrafts | undefined {
  if (!isRecord(value)) return undefined;
  const tidewe = sanitizeCreativeProfile(value.tidewe_outdoor);
  return tidewe ? { tidewe_outdoor: tidewe } : undefined;
}
export function createCreativeProfileSnapshot(profile: unknown, creativeConfigRevision: unknown, fallback: CreativeProfileFallback = {}): CreativeProfileSnapshot {
  return { profile: resolveCreativeProfile(profile, fallback), creativeConfigRevision: normalizedCreativeConfigRevision(creativeConfigRevision) };
}
function normalizedCreativeConfigRevision(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
/** Frozen settings stay authoritative; archived records retain shared media/history compatibility. */
export function checkCreativeProfileContext(project: CreativeProfileProjectContext, script: CreativeProfileScriptContext): CreativeProfileContextCheck {
  const projectProfile = resolveCreativeProfile(project.creativeProfile, { videoMode: project.videoMode });
  const projectRevision = normalizedCreativeConfigRevision(project.creativeConfigRevision);
  const snapshot = isRecord(script.creativeProfileSnapshot) ? script.creativeProfileSnapshot : undefined;
  const snapshotProfile = snapshot?.profile;
  const scriptProfile = snapshotProfile === undefined && script.styleType === TIDEWE_OUTDOOR_STYLE && isTideweOutdoorProfile(projectProfile)
    ? projectProfile : resolveCreativeProfile(snapshotProfile, { styleType: script.styleType, videoMode: project.videoMode });
  const scriptRevision = snapshot && typeof snapshot.creativeConfigRevision === "number" && Number.isFinite(snapshot.creativeConfigRevision)
    ? normalizedCreativeConfigRevision(snapshot.creativeConfigRevision) : undefined;
  if (projectProfile.creationType !== scriptProfile.creationType) {
    return { ok: false, code: "CREATIVE_PROFILE_MISMATCH", projectProfile, scriptProfile, projectRevision, scriptRevision };
  }
  const effectiveProfile = snapshotProfile === undefined ? projectProfile : scriptProfile;
  return { ok: true, projectProfile: effectiveProfile, scriptProfile: effectiveProfile, projectRevision, scriptRevision };
}
