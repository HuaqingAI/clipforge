import {
  createPremiumCgRecipeSnapshot,
  getPremiumCgRecipeFromSnapshot,
  normalizePremiumCgRecipeSnapshot,
  type PremiumCgRecipeSnapshot,
} from "@/lib/premium-cg-recipes";
import { TIDEWE_COMPILER_VERSION, TIDEWE_CORPUS_VERSION } from "@/lib/tidewe/types";
import type { TidewePresenterSnapshot } from "@/lib/tidewe/types";
import { isValidTidewePresenterInput, snapshotTidewePresenter } from "@/lib/tidewe/presenter";

/**
 * Versioned, server-authoritative creative profiles.
 *
 * These profiles describe content intent. They are intentionally separate from
 * generation-performance profiles (resolution, duration, and provider costs).
 */

export const PREMIUM_PRODUCT_CG_STYLE = "premium_product_cg" as const;
export const PREMIUM_PRODUCT_CG_PROFILE_ID = "premium_product_cg_v1" as const;
export const PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION = "premium-product-cg-2" as const;
export const SHORT_VIDEO_SALES_PROFILE_ID = "short_video_sales_v1" as const;
export const TIDEWE_OUTDOOR_STYLE = "tidewe_outdoor" as const;
export const TIDEWE_OUTDOOR_PROFILE_ID = "tidewe_outdoor_v1" as const;
export const TIDEWE_OUTDOOR_PROMPT_COMPILER_VERSION = TIDEWE_COMPILER_VERSION;

export type CreationType = "short_video_sales" | "premium_product_cg" | "tidewe_outdoor";
export type NarrationMode = "none" | "restrained";
export type PremiumSoundMode = "ambient" | "music" | "restrained-voice";
export type LegacyVideoMode = "product_closeup" | "graphic_montage" | "scene_demo" | "live_presenter";
export type PremiumProductCgVideoMode = Extract<LegacyVideoMode, "product_closeup" | "scene_demo">;
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

export interface PremiumProductCgTextPolicy {
  generatedFrameText: "forbid-added";
  productMarkings: "preserve-reference";
  captions: false;
  editorialGraphics: false;
  productCard: false;
  cta: "none";
  /** An explicitly approved end card is a deterministic post-production layer, never generated pixels. */
  brandEndCard: false | "approved";
}

export interface PremiumProductCgVisualDirection {
  /** modern_home is the legacy storage key for a category-appropriate usage context. */
  setting: "studio" | "modern_home";
  look: string;
  cameraSafety: "reference-limited";
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

export interface PremiumProductCgProfile {
  version: 1;
  id: typeof PREMIUM_PRODUCT_CG_PROFILE_ID;
  creationType: "premium_product_cg";
  styleType: typeof PREMIUM_PRODUCT_CG_STYLE;
  videoMode: PremiumProductCgVideoMode;
  targetDuration: 15 | 30 | 60;
  narrationMode: NarrationMode;
  soundMode: PremiumSoundMode;
  textPolicy: PremiumProductCgTextPolicy;
  visualDirection: PremiumProductCgVisualDirection;
  /** Frozen selection from the curated CG recipe library. */
  recipeSnapshot: PremiumCgRecipeSnapshot;
  promptCompilerVersion: typeof PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION;
}

export interface TideweOutdoorProfile {
  version: 1;
  id: typeof TIDEWE_OUTDOOR_PROFILE_ID;
  creationType: "tidewe_outdoor";
  styleType: "tidewe_outdoor";
  videoMode: PremiumProductCgVideoMode;
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

export type ProjectCreativeProfile = ShortVideoSalesProfile | PremiumProductCgProfile | TideweOutdoorProfile;

export interface ProjectCreativeProfileDrafts {
  short_video_sales?: ShortVideoSalesProfile;
  premium_product_cg?: PremiumProductCgProfile;
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

const PREMIUM_VIDEO_MODES = new Set<PremiumProductCgVideoMode>([
  "product_closeup",
  "scene_demo",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: unknown, fallback: string, maxLength = 240): string {
  const text = asTrimmedString(value);
  return text ? text.slice(0, maxLength) : fallback;
}

/** Upgrade only shipped defaults; an explicitly chosen custom look remains intact. */
function normalizePremiumCgLook(value: unknown, fallback: string): string {
  const look = asTrimmedString(value);
  if (look === "quiet premium furniture product film") return fallback;
  if (look === "controlled neutral studio light, calm architectural backdrop, measured silhouette and edge highlights") {
    return createPremiumCgRecipeSnapshot("form_portrait").visualLook;
  }
  if (look === "bright quiet contemporary residence, soft natural window light, low-saturation neutral materials and balanced spatial scale") {
    return createPremiumCgRecipeSnapshot("living_scale").visualLook;
  }
  return boundedText(look, fallback);
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

function normalizePremiumVideoMode(value: unknown): PremiumProductCgVideoMode {
  const candidate = normalizeVideoMode(value);
  return PREMIUM_VIDEO_MODES.has(candidate as PremiumProductCgVideoMode) ? candidate as PremiumProductCgVideoMode : "product_closeup";
}

function normalizeSalesDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(600, Math.round(value)));
}

function normalizePremiumDuration(value: unknown): 15 | 30 | 60 {
  return value === 15 || value === 30 || value === 60 ? value : 30;
}

function normalizeNarrationMode(value: unknown): NarrationMode {
  return value === "restrained" ? "restrained" : "none";
}

function normalizeSoundMode(value: unknown, narrationMode: NarrationMode): PremiumSoundMode {
  if (narrationMode === "none") {
    return value === "music" ? "music" : "ambient";
  }
  return value === "ambient" || value === "music" || value === "restrained-voice"
    ? value
    : "restrained-voice";
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

/**
 * Creates the canonical premium product CG profile. The text and compose policy is deliberately
 * not configurable here: user input cannot re-enable generated copy, captions, overlays, cards, or CTAs.
 */
export function createPremiumProductCgProfile(options: {
  targetDuration?: unknown;
  videoMode?: unknown;
  narrationMode?: unknown;
  soundMode?: unknown;
  visualDirection?: unknown;
  recipeSnapshot?: unknown;
  brandEndCard?: unknown;
} = {}): PremiumProductCgProfile {
  const recipeSnapshot = normalizePremiumCgRecipeSnapshot(options.recipeSnapshot)
    ?? createPremiumCgRecipeSnapshot();
  const recipe = getPremiumCgRecipeFromSnapshot(recipeSnapshot);
  const direction = isRecord(options.visualDirection) ? options.visualDirection : {};
  const narrationMode = normalizeNarrationMode(options.narrationMode);
  return {
    version: 1,
    id: PREMIUM_PRODUCT_CG_PROFILE_ID,
    creationType: "premium_product_cg",
    styleType: PREMIUM_PRODUCT_CG_STYLE,
    videoMode: options.videoMode === undefined
      ? recipeSnapshot.videoMode
      : normalizePremiumVideoMode(options.videoMode),
    targetDuration: normalizePremiumDuration(options.targetDuration),
    narrationMode,
    soundMode: normalizeSoundMode(options.soundMode, narrationMode),
    textPolicy: {
      generatedFrameText: "forbid-added",
      productMarkings: "preserve-reference",
      captions: false,
      editorialGraphics: false,
      productCard: false,
      cta: "none",
      brandEndCard: options.brandEndCard === "approved" ? "approved" : false,
    },
    visualDirection: {
      setting: direction.setting === "modern_home"
        ? "modern_home"
        : direction.setting === "studio"
          ? "studio"
          : recipeSnapshot.setting,
      look: normalizePremiumCgLook(direction.look, recipe?.visualLook ?? "quiet premium product film"),
      cameraSafety: "reference-limited",
    },
    recipeSnapshot,
    promptCompilerVersion: PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION,
  };
}

function premiumSignal(value: Record<string, unknown>): boolean {
  const id = value.id ?? value.profileId ?? value.creativeProfileId;
  return value.creationType === "premium_product_cg"
    || value.styleType === PREMIUM_PRODUCT_CG_STYLE
    || id === PREMIUM_PRODUCT_CG_PROFILE_ID;
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
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID) return "premium_product_cg";
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) return "short_video_sales";
  return undefined;
}

function profileTypeFromStyle(value: unknown): CreationType | undefined {
  const style = asTrimmedString(value)?.toLowerCase();
  if (!style) return undefined;
  if (style === PREMIUM_PRODUCT_CG_STYLE) return "premium_product_cg";
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
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID || value === PREMIUM_PRODUCT_CG_STYLE) {
    return { profile: createPremiumProductCgProfile() };
  }
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) {
    return { profile: createShortVideoSalesProfile() };
  }
  if (!isRecord(value)) {
    return { error: "Creative profile must be an object or a known profile identifier." };
  }

  const identities: CreationType[] = [];
  const creationType = value.creationType;
  if (creationType !== undefined) {
    if (creationType !== "short_video_sales" && creationType !== "premium_product_cg" && creationType !== "tidewe_outdoor") {
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
 *
 * Compatibility: old clients may send profileId/creativeProfileId and a string textPolicy. Neither
 * can weaken the premium policy; they only identify the premium profile to be canonicalized.
 */
export function sanitizeCreativeProfile(value: unknown): ProjectCreativeProfile | undefined {
  if (value === TIDEWE_OUTDOOR_STYLE || value === TIDEWE_OUTDOOR_PROFILE_ID) return createTideweOutdoorProfile();
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID || value === PREMIUM_PRODUCT_CG_STYLE) {
    return createPremiumProductCgProfile();
  }
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

  if (premiumSignal(value)) {
    const legacyTextPolicy = value.textPolicy;
    const textPolicy = isRecord(legacyTextPolicy) ? legacyTextPolicy : {};
    return createPremiumProductCgProfile({
      targetDuration: value.targetDuration,
      videoMode: value.videoMode,
      narrationMode: value.narrationMode,
      soundMode: value.soundMode,
      visualDirection: value.visualDirection,
      recipeSnapshot: value.recipeSnapshot,
      brandEndCard: textPolicy.brandEndCard ?? value.brandEndCard,
    });
  }

  const id = value.id ?? value.profileId ?? value.creativeProfileId;
  const declaresSales = value.creationType === "short_video_sales" || id === SHORT_VIDEO_SALES_PROFILE_ID;
  const hasLegacySalesShape = typeof value.styleType === "string" || typeof value.videoMode === "string";
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
  const premium = sanitizeCreativeProfile(value.premium_product_cg ?? value.cg);
  const tidewe = sanitizeCreativeProfile(value.tidewe_outdoor);
  const result: ProjectCreativeProfileDrafts = {};
  if (sales?.creationType === "short_video_sales") result.short_video_sales = sales;
  if (premium?.creationType === "premium_product_cg") result.premium_product_cg = premium;
  if (tidewe?.creationType === "tidewe_outdoor") result.tidewe_outdoor = tidewe;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** True only for the canonical premium CG profile (including compatibility-shaped input). */
export function isPremiumProductCgProfile(profile?: unknown): profile is PremiumProductCgProfile {
  return sanitizeCreativeProfile(profile)?.creationType === "premium_product_cg";
}

/** Resolve a persisted project row before deciding whether a restricted CG policy applies. */
export function isPremiumProductCgProject(
  project: Pick<CreativeProfileProjectContext, "creativeProfile" | "videoMode">,
): boolean {
  return isPremiumProductCgProfile(resolveCreativeProfile(project.creativeProfile, {
    videoMode: project.videoMode,
  }));
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
 * Checks that a script may drive a current-generation action for a project. A script snapshot
 * captures the profile chosen when it was generated; after a type switch or settings change,
 * downstream generation must be replanned rather than quietly applying a stale visual policy.
 *
 * Rows created before profile snapshots existed remain readable: they are classified from their
 * stored style and only participate in the type check. New snapshots also carry a revision and
 * are rejected after the project's creation settings change.
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
  if (scriptRevision !== undefined && scriptRevision !== projectRevision) {
    return {
      ok: false,
      code: "CREATIVE_CONFIG_STALE",
      projectProfile,
      scriptProfile,
      projectRevision,
      scriptRevision,
    };
  }
  return { ok: true, projectProfile, scriptProfile, projectRevision, scriptRevision };
}
