import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { mkdir, writeFile } from "fs/promises";
import { join, basename } from "path";
import { parseProductFromHtml } from "@/lib/product-ingest";
import { inferExtension, MAX_DOWNLOAD_BYTES } from "@/lib/providers/stock-types";
import { safeFetch } from "@/lib/ssrf-guard";
import { apiError, errText } from "@/lib/api-error";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
  sanitizeCreativeProfileDrafts,
  validateCreativeProfileInput,
  type CreativeProfileFallback,
  type ProjectCreativeProfile,
  type ProjectCreativeProfileDrafts,
} from "@/lib/creative-profiles";

const UA = "Mozilla/5.0 (compatible; ClipForge/1.0; +https://github.com/xixihhhh/clipforge)";
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 3;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requestedCreativeProfile(value: JsonRecord): unknown | undefined {
  if (hasOwn(value, "creativeProfile")) return value.creativeProfile;
  if (hasOwn(value, "profile")) return value.profile;
  if (!hasOwn(value, "creationType") && !hasOwn(value, "profileId") && !hasOwn(value, "creativeProfileId")) {
    return undefined;
  }
  const profile: JsonRecord = {};
  for (const key of [
    "creationType", "profileId", "creativeProfileId", "styleType", "videoMode", "targetDuration",
    "duration", "narrationMode", "soundMode", "textPolicy", "visualDirection", "brandEndCard",
    "composeSnapshot", "compose", "creativeSettings", "recipeSnapshot",
  ]) {
    if (hasOwn(value, key)) profile[key] = value[key];
  }
  if (profile.targetDuration === undefined && profile.duration !== undefined) profile.targetDuration = profile.duration;
  if (profile.composeSnapshot === undefined && profile.compose !== undefined) profile.composeSnapshot = profile.compose;
  return profile;
}

function creativeFallback(value: JsonRecord): CreativeProfileFallback {
  return {
    styleType: value.styleType,
    videoMode: value.videoMode,
    targetDuration: value.targetDuration ?? value.duration,
    composeSnapshot: value.composeSnapshot ?? value.compose,
    creativeSettings: value.creativeSettings,
    recipeSnapshot: value.recipeSnapshot,
  };
}

function createProfileDrafts(
  profile: ProjectCreativeProfile,
  rawDrafts: unknown,
  fallback: CreativeProfileFallback,
): ProjectCreativeProfileDrafts {
  const drafts: ProjectCreativeProfileDrafts = { ...(sanitizeCreativeProfileDrafts(rawDrafts) ?? {}) };
  if (!drafts.short_video_sales) drafts.short_video_sales = createShortVideoSalesProfile(fallback);
  if (!drafts.premium_product_cg) drafts.premium_product_cg = createPremiumProductCgProfile();
  if (profile.creationType === "premium_product_cg") drafts.premium_product_cg = profile;
  else drafts.short_video_sales = profile;
  return drafts;
}

type ProjectCreationCreativeConfig = {
  creativeProfile: ProjectCreativeProfile;
  creativeProfileDrafts: ProjectCreativeProfileDrafts;
};

type ProjectCreationCreativeConfigResult =
  | ProjectCreationCreativeConfig
  | { error: string; code?: "CREATIVE_PROFILE_REQUIRED" };

function projectCreationCreativeConfig(
  body: JsonRecord,
): ProjectCreationCreativeConfigResult {
  const requestedProfile = requestedCreativeProfile(body);
  if (requestedProfile === undefined) {
    return {
      error: "Choose a creation type before creating a project.",
      code: "CREATIVE_PROFILE_REQUIRED",
    };
  }
  const profileResult = validateCreativeProfileInput(requestedProfile);
  if ("error" in profileResult) return { error: profileResult.error ?? "Invalid creative profile." };

  const fallback = creativeFallback(body);
  return {
    creativeProfile: profileResult.profile,
    creativeProfileDrafts: createProfileDrafts(profileResult.profile, body.creativeProfileDrafts, fallback),
  };
}

/** Download a single product image to local disk with SSRF protection (safeFetch validates each redirect hop to block og:image pointing to internal addresses). */
async function safeDownloadImage(url: string, destDir: string, base: string): Promise<string> {
  const res = await safeFetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}`);
  const ct = res.headers.get("content-type");
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_DOWNLOAD_BYTES) throw new Error("图片体积超限");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("图片体积超限");
  const filePath = join(destDir, `${base}.${inferExtension(url, ct, "image")}`);
  await writeFile(filePath, buf);
  return filePath;
}

/**
 * POST /api/ingest/product — one-click product link import.
 * body: { url, createProject? } (createProject defaults to true: create a commerce project + download the first 3 product images)
 * Fetch product page → parse title/price/description/images → (optionally) persist as a project; the frontend/MCP can then use the projectId to go straight to script → video generation.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsedBody: unknown = await req.json();
    if (!isRecord(parsedBody)) {
      return apiError(req, "Request body must be a JSON object", "Request body must be a JSON object", 400);
    }
    body = parsedBody;
  } catch {
    return apiError(req, "请求体不是合法 JSON", "Request body is not valid JSON");
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\/.+/i.test(url)) {
    return apiError(req, "请填写合法的商品链接（http/https）", "Please provide a valid product link (http/https)");
  }
  const createProject = body.createProject !== false;
  const libraryProductId =
    typeof body.libraryProductId === "string" && /^[a-zA-Z0-9\-]+$/.test(body.libraryProductId)
      ? body.libraryProductId
      : undefined;

  // Product-library imports only analyze and save library media. A project-creating request must
  // explicitly declare its creation type instead of inheriting the historical sales default.
  const projectCreativeConfig = createProject && !libraryProductId
    ? projectCreationCreativeConfig(body)
    : undefined;
  if (projectCreativeConfig && "error" in projectCreativeConfig) {
    return NextResponse.json(projectCreativeConfig, { status: 400 });
  }
  if (hasOwn(body, "creativeProfileDrafts") && !isRecord(body.creativeProfileDrafts)) {
    return NextResponse.json({ error: "creativeProfileDrafts must be a JSON object." }, { status: 400 });
  }

  // Fetch HTML (descriptive UA + timeout + size cap)
  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    // safeFetch: blocks internal/metadata addresses + validates each redirect hop (SSRF prevention)
    const res = await safeFetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return apiError(req, `抓取商品页失败：HTTP ${res.status}`, `Failed to fetch product page: HTTP ${res.status}`, 502);
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      return apiError(req, "该链接不是网页（非 HTML），无法解析", "This link is not a web page (not HTML) and cannot be parsed", 415);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    html = buf.subarray(0, MAX_HTML_BYTES).toString("utf8");
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? errText(req, "抓取超时", "Fetch timed out") : e instanceof Error ? e.message : String(e);
    return apiError(req, `抓取商品页失败：${msg}`, `Failed to fetch product page: ${msg}`, 502);
  }

  const product = parseProductFromHtml(html, url);
  if (!product.title && product.images.length === 0) {
    return NextResponse.json({ error: errText(req, "没能从该链接解析出商品信息，请改用手动填写", "Could not parse product info from this link; please fill it in manually"), product }, { status: 422 });
  }

  // Library-import mode: no project — download the product images into the product-library
  // storage (uploads/products/<id>/) and return persistent /api/files URLs. The page shows the
  // parsed fields in an editable review card; nothing enters the library until the user confirms.
  if (libraryProductId) {
    const destDir = join(getUploadsDir(), "products", libraryProductId);
    await mkdir(destDir, { recursive: true });
    const savedImages: string[] = [];
    for (const [i, img] of product.images.slice(0, MAX_IMAGES).entries()) {
      try {
        const filePath = await safeDownloadImage(img, destDir, `ingest_${Date.now()}_${i}`);
        savedImages.push(`/api/files/products/${libraryProductId}/${basename(filePath)}`);
      } catch {
        /* Skip images that fail to download or are blocked by SSRF protection */
      }
    }
    return NextResponse.json({ product, images: savedImages });
  }

  if (!createProject) return NextResponse.json({ product });
  if (!projectCreativeConfig || "error" in projectCreativeConfig) {
    return NextResponse.json({ error: "Creative profile is required for project creation." }, { status: 400 });
  }
  const { creativeProfile, creativeProfileDrafts } = projectCreativeConfig;

  // Create a commerce project + download the first few product images and persist them
  const db = getDb();
  const name = (product.title || "导入的商品").slice(0, 60);
  const [proj] = await db
    .insert(projects)
    .values({
      name,
      contentType: "product",
      productName: name,
      productDescription: product.description ?? null,
      productPrice: product.priceText ?? null,
      // Preserve the storefront link so it can flow into publish copy (UTM-tagged) and an end-card QR code
      shopUrl: url,
      productImages: [],
      videoMode: creativeProfile.videoMode,
      creativeProfile,
      creativeProfileDrafts,
      creativeConfigRevision: 1,
    })
    .returning();

  const destDir = join(getUploadsDir(), proj.id);
  await mkdir(destDir, { recursive: true });
  const saved: string[] = [];
  for (const [i, img] of product.images.slice(0, MAX_IMAGES).entries()) {
    try {
      const filePath = await safeDownloadImage(img, destDir, `ingest_${Date.now()}_${i}`);
      saved.push(`/api/files/${proj.id}/${basename(filePath)}`);
    } catch {
      /* Skip images that fail to download or are blocked by SSRF protection */
    }
  }
  if (saved.length > 0) {
    await db.update(projects).set({ productImages: saved, updatedAt: new Date() }).where(eq(projects.id, proj.id));
  }

  return NextResponse.json({ projectId: proj.id, product, productImages: saved });
}
