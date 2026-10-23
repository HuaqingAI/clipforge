import {
  createPremiumCgRecipeSnapshot,
  getPremiumCgRecipeFromSnapshot,
  normalizePremiumCgRecipeSnapshot,
  type PremiumCgRecipeSnapshot,
} from "@/lib/premium-cg-recipes";

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

export type CreationType = "short_video_sales" | "premium_product_cg";
export type ProductVisualSource = "product_image" | "ai_generate";
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
  visualSource: ProductVisualSource;
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
  visualSource: ProductVisualSource;
  targetDuration: 15 | 30 | 60;
  narrationMode: NarrationMode;
  soundMode: PremiumSoundMode;
  textPolicy: PremiumProductCgTextPolicy;
  visualDirection: PremiumProductCgVisualDirection;
  /** Frozen selection from the curated CG recipe library. */
  recipeSnapshot: PremiumCgRecipeSnapshot;
  promptCompilerVersion: typeof PREMIUM_PRODUCT_CG_PROMPT_COMPILER_VERSION;
}

export type ProjectCreativeProfile = ShortVideoSalesProfile | PremiumProductCgProfile;

export interface ProjectCreativeProfileDrafts {
  short_video_sales?: ShortVideoSalesProfile;
  premium_product_cg?: PremiumProductCgProfile;
}

export interface CreativeProfileFallback {
  styleType?: unknown;
  videoMode?: unknown;
  visualSource?: unknown;
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

function normalizeProductVisualSource(value: unknown): ProductVisualSource {
  return value === "ai_generate" ? "ai_generate" : "product_image";
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
    visualSource: normalizeProductVisualSource(fallback.visualSource),
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
  visualSource?: unknown;
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
    visualSource: normalizeProductVisualSource(options.visualSource),
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

function profileTypeFromId(value: unknown): CreationType | undefined {
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID) return "premium_product_cg";
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) return "short_video_sales";
  return undefined;
}

function profileTypeFromStyle(value: unknown): CreationType | undefined {
  const style = asTrimmedString(value)?.toLowerCase();
  if (!style) return undefined;
  if (style === PREMIUM_PRODUCT_CG_STYLE) return "premium_product_cg";
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
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID || value === PREMIUM_PRODUCT_CG_STYLE) {
    return { profile: createPremiumProductCgProfile() };
  }
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) {
    return { profile: createShortVideoSalesProfile() };
  }
  if (!isRecord(value)) {
    return { error: "Creative profile must be an object or a known profile identifier." };
  }
  if (value.visualSource !== undefined && value.visualSource !== "product_image" && value.visualSource !== "ai_generate") {
    return { error: "Creative profile visualSource must be product_image or ai_generate." };
  }

  const identities: CreationType[] = [];
  const creationType = value.creationType;
  if (creationType !== undefined) {
    if (creationType !== "short_video_sales" && creationType !== "premium_product_cg") {
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
  if (value === PREMIUM_PRODUCT_CG_PROFILE_ID || value === PREMIUM_PRODUCT_CG_STYLE) {
    return createPremiumProductCgProfile();
  }
  if (value === SHORT_VIDEO_SALES_PROFILE_ID) {
    return createShortVideoSalesProfile();
  }
  if (!isRecord(value)) return undefined;

  if (premiumSignal(value)) {
    const legacyTextPolicy = value.textPolicy;
    const textPolicy = isRecord(legacyTextPolicy) ? legacyTextPolicy : {};
    return createPremiumProductCgProfile({
      targetDuration: value.targetDuration,
      videoMode: value.videoMode,
      visualSource: value.visualSource,
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
    visualSource: value.visualSource,
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
  return sanitizeCreativeProfile(value) ?? createShortVideoSalesProfile(fallback);
}

/** Validate new draft writes before the tolerant persisted-data sanitizer can apply defaults. */
export function creativeProfileDraftsInputError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "creativeProfileDrafts must be a JSON object.";
  const draftTypes: Record<string, CreationType> = {
    short_video_sales: "short_video_sales",
    sales: "short_video_sales",
    premium_product_cg: "premium_product_cg",
    cg: "premium_product_cg",
  };
  for (const [key, creationType] of Object.entries(draftTypes)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const checked = validateCreativeProfileInput(value[key]);
    if (checked.error) return `creativeProfileDrafts.${key}: ${checked.error}`;
    if (checked.profile?.creationType !== creationType) {
      return `creativeProfileDrafts.${key} must describe the ${creationType} profile.`;
    }
  }
  return undefined;
}

export function sanitizeCreativeProfileDrafts(value: unknown): ProjectCreativeProfileDrafts | undefined {
  if (!isRecord(value)) return undefined;
  const sales = sanitizeCreativeProfile(value.short_video_sales ?? value.sales);
  const premium = sanitizeCreativeProfile(value.premium_product_cg ?? value.cg);
  const result: ProjectCreativeProfileDrafts = {};
  if (sales?.creationType === "short_video_sales") result.short_video_sales = sales;
  if (premium?.creationType === "premium_product_cg") result.premium_product_cg = premium;
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
