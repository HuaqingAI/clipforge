import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION } from "@/lib/tidewe/types";
import type { TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { isValidTidewePresenterInput, snapshotTidewePresenter } from "@/lib/tidewe/presenter";

/**
 * Versioned, server-authoritative creative profiles.
 *
 * These profiles describe content intent. They are intentionally separate from
 * generation-performance profiles (resolution, duration, and provider costs).
 */

export const SHORT_VIDEO_SALES_PROFILE_ID = "short_video_sales_v1" as const;
export const TIDEWE_OUTDOOR_STYLE = "tidewe_outdoor" as const;
export const TIDEWE_OUTDOOR_PROFILE_ID = "tidewe_outdoor_v1" as const;
export const TIDEWE_OUTDOOR_PROMPT_COMPILER_VERSION = TIDEWE_COMPILER_VERSION;

export type CreationType = "short_video_sales" | "tidewe_outdoor";
export type LegacyVideoMode = "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter";
export type LegacySalesStyle =
  | "pain_point"
  | "scene"
  | "comparison"
  | "story"
  | "drama"
  | "reversal"
  | "interview"
  | "unboxing"
  | "product_pov"
  | "talking_head"
  | "custom";

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

export interface LegacyCreativeSettings {
  look?: string;
  cameraPlan?: Record<string, unknown>;
  soundMode?: string;
  [key: string]: unknown;
}

export interface ShortVideoSalesProfile {
  version: 1;
  id: typeof SHORT_VIDEO_SALES_PROFILE_ID;
  creationType: "short_video_sales";
  styleType: LegacySalesStyle;
  videoMode: LegacyVideoMode;
  targetDuration: number;
  composeSnapshot: LegacyComposeSettings;
  creativeSettings: LegacyCreativeSettings;
  recipeSnapshot?: Record<string, unknown>;
  promptCompilerVersion: "short-video-sales-1";
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

export type ProjectCreativeProfile = ShortVideoSalesProfile | TideweOutdoorProfile;

export interface ProjectCreativeProfileDrafts {
  short_video_sales?: ShortVideoSalesProfile;
  tidewe_outdoor?: TideweOutdoorProfile;
}

export interface CreativeProfileFallback {
  styleType?: unknown;
  videoMode?: unknown;
  targetDuration?: unknown;
  composeSnapshot?: unknown;
  creativeSettings?: unknown;
  recipeSnapshot?: unknown;
}

export interface CreativeProfileSnapshot {
  profile: ProjectCreativeProfile;
  creativeConfigRevision: number;
}

/**
 * Minimal structural shapes accepted by generation routes. Keeping this independent from the
 * database schema makes the policy check usable before a route decides which columns to select.
 */
export interface CreativeProfileProjectContext {
  creativeProfile?: unknown;
  videoMode?: unknown;
  creativeConfigRevision?: unknown;
}

export interface CreativeProfileScriptContext {
  styleType?: unknown;
  creativeProfileSnapshot?: unknown;
}

export type CreativeProfileContextCheck =
  | {
    ok: true;
    projectProfile: ProjectCreativeProfile;
    scriptProfile: ProjectCreativeProfile;
    projectRevision: number;
    scriptRevision?: number;
  }
  | {
    ok: false;
    code: "CREATIVE_PROFILE_MISMATCH" | "CREATIVE_CONFIG_STALE";
    projectProfile: ProjectCreativeProfile;
    scriptProfile: ProjectCreativeProfile;
    projectRevision: number;
    scriptRevision?: number;
  };

export type CreativeProfileInputResult =
  | { profile: ProjectCreativeProfile; error?: never }
  | { profile?: never; error: string };

const SALES_STYLES = new Set<LegacySalesStyle>([
  "pain_point",
  "scene",
  "comparison",
  "story",
  "drama",
  "reversal",
  "interview",
  "unboxing",
  "product_pov",
  "talking_head",
  "custom",
]);

const VIDEO_MODES = new Set<LegacyVideoMode>([
  "product_closeup",
  "graphic_montage",
  "scene_demo",
  "live_presenter",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shallowJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 80) continue;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      output[key] = item;
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 50);
    } else if (isRecord(item)) {
      output[key] = { ...item };
    }
  }
  return output;
}

function normalizeSalesStyle(value: unknown): LegacySalesStyle {
  const raw = asTrimmedString(value)?.toLowerCase();
  const aliases: Record<string, LegacySalesStyle> = {
    "pain-point": "pain_point",
    scenario: "scene",
    auto: "pain_point",
  };
  const candidate = raw ? aliases[raw] ?? raw : "pain_point";
  return SALES_STYLES.has(candidate as LegacySalesStyle) ? candidate as LegacySalesStyle : "pain_point";
}

function normalizeVideoMode(value: unknown): LegacyVideoMode {
  const raw = asTrimmedString(value)?.toLowerCase();
  return raw && VIDEO_MODES.has(raw as LegacyVideoMode) ? raw as LegacyVideoMode : "product_closeup";
}

function normalizeSalesDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(600, Math.round(value)));
}

function sanitizeComposeSnapshot(value: unknown): LegacyComposeSettings {
  return shallowJsonRecord(value) ?? {};
}

function sanitizeCreativeSettings(value: unknown): LegacyCreativeSettings {
  return shallowJsonRecord(value) ?? {};
}

/** Creates the canonical default profile for legacy short-form sales projects. */
export function createShortVideoSalesProfile(fallback: CreativeProfileFallback = {}): ShortVideoSalesProfile {
  const recipeSnapshot = shallowJsonRecord(fallback.recipeSnapshot);
  return {
    version: 1,
    id: SHORT_VIDEO_SALES_PROFILE_ID,
    creationType: "short_video_sales",
    styleType: normalizeSalesStyle(fallback.styleType),
    videoMode: normalizeVideoMode(fallback.videoMode),
    targetDuration: normalizeSalesDuration(fallback.targetDuration),
    composeSnapshot: sanitizeComposeSnapshot(fallback.composeSnapshot),
    creativeSettings: sanitizeCreativeSettings(fallback.creativeSettings),
    ...(recipeSnapshot && { recipeSnapshot }),
    promptCompilerVersion: "short-video-sales-1",
  };
}

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

function profileTypeFromId(value: unknown): CreationType | undefined {
  if (value === TIDEWE_OUTDOOR_PROFILE_ID) return "tidewe_outdoor";
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) return "short_video_sales";
  return undefined;
}

function profileTypeFromStyle(value: unknown): CreationType | undefined {
  const style = asTrimmedString(value)?.toLowerCase();
  if (!style) return undefined;
  if (style === TIDEWE_OUTDOOR_STYLE) return "tidewe_outdoor";
  const aliases: Record<string, LegacySalesStyle> = {
    "pain-point": "pain_point",
    scenario: "scene",
    auto: "pain_point",
  };
  return SALES_STYLES.has((aliases[style] ?? style) as LegacySalesStyle)
    ? "short_video_sales"
    : undefined;
}

/**
 * Validates a caller-supplied creative-profile identity before canonicalizing it.
 *
 * `sanitizeCreativeProfile` remains deliberately tolerant for old database rows. New writes use
 * this helper so a client cannot silently turn an invalid or mixed profile into a different
 * creation type by relying on defaults.
 */
export function validateCreativeProfileInput(value: unknown): CreativeProfileInputResult {
  if (value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID) return { profile: createTideweOutdoorProfile() };
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) {
    return { profile: createShortVideoSalesProfile() };
  }
  if (!isRecord(value)) {
    return { error: "Creative profile must be an object or a known profile identifier." };
  }

  const identities: CreationType[] = [];
  const creationType = value.creationType;
  if (creationType !== undefined) {
    if (creationType !== "short_video_sales" && creationType !== "tidewe_outdoor") {
      return { error: "Unknown creative creationType." };
    }
    identities.push(creationType);
  }

  const profileIds = [value.id, value.profileId, value.creativeProfileId]
    .filter((item) => item !== undefined && item !== null);
  for (const profileId of profileIds) {
    const profileType = profileTypeFromId(profileId);
    if (!profileType) return { error: "Unknown creative profile identifier." };
    identities.push(profileType);
  }

  const rawStyle = value.styleType;
  if (rawStyle !== undefined && rawStyle !== null) {
    if (typeof rawStyle !== "string" || !rawStyle.trim()) {
      return { error: "Creative profile styleType must be a non-empty string." };
    }
    const styleType = profileTypeFromStyle(rawStyle);
    if (!styleType) return { error: "Unknown creative profile styleType." };
    identities.push(styleType);
  }

  if (identities.length === 0) {
    return { error: "Creative profile must declare a creationType, profile identifier, or styleType." };
  }
  if (identities.some((identity) => identity !== identities[0])) {
    return { error: "Creative profile creationType, identifier, and styleType must describe the same profile." };
  }

  const profile = sanitizeCreativeProfile(value);
  if (!profile || profile.creationType !== identities[0]) {
    return { error: "Creative profile could not be resolved." };
  }
  if (profile.creationType === "tidewe_outdoor") {
    if (value.version !== undefined && value.version !== 1) return { error: "Unsupported TIDEWE profile version." };
    if (value.speechMode !== undefined && value.speechMode !== "on_camera" && value.speechMode !== "voiceover") return { error: "Unsupported TIDEWE speech mode." };
    if (value.presenter != null && !isValidTidewePresenterInput(value.presenter)) return { error: "请选择有外貌描述或参考图的有效出镜主播。" };
    try { assertSupportedTideweProfile(profile); } catch (e) { return { error: (e as Error).message }; }
  }
  return { profile };
}

/**
 * Strictly sanitizes persisted or client supplied profile data. It returns undefined for data that
 * does not identify a creative profile; callers that need a default should use resolveCreativeProfile.
 */
export function sanitizeCreativeProfile(value: unknown): ProjectCreativeProfile | undefined {
  if (value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID) return createTideweOutdoorProfile();
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) {
    return createShortVideoSalesProfile();
  }
  if (!isRecord(value)) return undefined;

  if (tideweSignal(value)) {
    const profile = createTideweOutdoorProfile(value);
    // History keeps the actual compiler/corpus used, even after an upgrade.
    return { ...profile, ...(typeof value.version === "number" && { version: value.version as 1 }),
      ...(typeof value.corpusVersion === "string" && { corpusVersion: value.corpusVersion }),
      ...(typeof value.promptCompilerVersion === "string" && { promptCompilerVersion: value.promptCompilerVersion }) };
  }

  const id = value.id ?? value.profileId ?? value.creativeProfileId;
  const declaresSales = value.creationType === "short_video_sales" || id === SHORT_VIDEO_SALES_PROFILE_ID;
  if (value.creationType !== undefined && value.creationType !== "short_video_sales") return undefined;
  if (id !== undefined && id !== SHORT_VIDEO_SALES_PROFILE_ID) return undefined;
  const hasLegacySalesShape = profileTypeFromStyle(value.styleType) === "short_video_sales"
    || (value.styleType === undefined && typeof value.videoMode === "string");
  if (!declaresSales && !hasLegacySalesShape) return undefined;

  return createShortVideoSalesProfile({
    styleType: value.styleType,
    videoMode: value.videoMode,
    targetDuration: value.targetDuration,
    composeSnapshot: value.composeSnapshot ?? value.compose,
    creativeSettings: value.creativeSettings,
    recipeSnapshot: value.recipeSnapshot,
  });
}

/** Resolves a profile with an explicit legacy-sales fallback for projects that have not migrated yet. */
export function resolveCreativeProfile(
  value: unknown,
  fallback: CreativeProfileFallback = {},
): ProjectCreativeProfile {
  return sanitizeCreativeProfile(value) ?? (fallback.styleType === TIDEWE_OUTDOOR_STYLE
    ? createTideweOutdoorProfile(fallback) : createShortVideoSalesProfile(fallback));
}

export function sanitizeCreativeProfileDrafts(value: unknown): ProjectCreativeProfileDrafts | undefined {
  if (!isRecord(value)) return undefined;
  const sales = sanitizeCreativeProfile(value.short_video_sales ?? value.sales);
  const tidewe = sanitizeCreativeProfile(value.tidewe_outdoor);
  const result: ProjectCreativeProfileDrafts = {};
  if (sales?.creationType === "short_video_sales") result.short_video_sales = sales;
  if (tidewe?.creationType === "tidewe_outdoor") result.tidewe_outdoor = tidewe;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Makes the script-level immutable creative context persisted with a generated script revision. */
export function createCreativeProfileSnapshot(
  profile: unknown,
  creativeConfigRevision: unknown,
  fallback: CreativeProfileFallback = {},
): CreativeProfileSnapshot {
  const revision = typeof creativeConfigRevision === "number" && Number.isFinite(creativeConfigRevision)
    ? Math.max(0, Math.floor(creativeConfigRevision))
    : 0;
  return {
    profile: resolveCreativeProfile(profile, fallback),
    creativeConfigRevision: revision,
  };
}

function normalizedCreativeConfigRevision(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/**
 * Resolves the policy for a saved script option. Revision counters are provenance only:
 * the same option may keep driving generation, adoption and composition after settings edits.
 * Its frozen policy remains authoritative; project/script/shot ownership is checked by callers.
 * A different creation type is still incompatible with the project's locked type.
 */
export function checkCreativeProfileContext(
  project: CreativeProfileProjectContext,
  script: CreativeProfileScriptContext,
): CreativeProfileContextCheck {
  const projectProfile = resolveCreativeProfile(project.creativeProfile, {
    videoMode: project.videoMode,
  });
  const projectRevision = normalizedCreativeConfigRevision(project.creativeConfigRevision);
  const snapshot = isRecord(script.creativeProfileSnapshot) ? script.creativeProfileSnapshot : undefined;
  const snapshotProfile = snapshot?.profile;
  const scriptProfile = resolveCreativeProfile(snapshotProfile, {
    styleType: script.styleType,
    videoMode: project.videoMode,
  });
  const hasFrozenRevision = snapshot && typeof snapshot.creativeConfigRevision === "number"
    && Number.isFinite(snapshot.creativeConfigRevision);
  const scriptRevision = hasFrozenRevision
    ? normalizedCreativeConfigRevision(snapshot.creativeConfigRevision)
    : undefined;

  if (projectProfile.creationType !== scriptProfile.creationType) {
    return {
      ok: false,
      code: "CREATIVE_PROFILE_MISMATCH",
      projectProfile,
      scriptProfile,
      projectRevision,
      scriptRevision,
    };
  }
  const effectiveProfile = snapshotProfile === undefined ? projectProfile : scriptProfile;
  return { ok: true, projectProfile: effectiveProfile, scriptProfile: effectiveProfile, projectRevision, scriptRevision };
}
