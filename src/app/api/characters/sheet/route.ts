import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { createProvider } from "@/lib/providers";
import { buildCharacterSheetPrompt } from "@/lib/character-sheet";
import { MAX_CHARACTER_REFERENCE_IMAGES } from "@/lib/character-reference";
import { resolveCharacterReferenceModel } from "@/lib/character-reference-model";
import { toRemoteUsableImage } from "@/lib/remote-image";
import { apiError, errText } from "@/lib/api-error";

/**
 * POST /api/characters/sheet — generate a presenter's 2x2 multi-view reference
 * sheet (front / side / back / close-up in ONE generation, so it's physically
 * the same person). The client stores the returned path on the character; the
 * storyboard grid and film passes then attach it as a reference image to keep
 * the presenter's identity locked across shots and videos.
 *
 * body: { appearance?, name?, referenceImageUrls?, provider, model, apiKey, baseUrl?, options? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { appearance, name, referenceImageUrls, provider: providerName, model, apiKey, baseUrl, options } = body as {
      appearance?: string;
      name?: string;
      referenceImageUrls?: unknown;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      options?: Record<string, unknown>;
    };
    if (referenceImageUrls !== undefined && (
      !Array.isArray(referenceImageUrls)
      || referenceImageUrls.length > MAX_CHARACTER_REFERENCE_IMAGES
      || referenceImageUrls.some((url) => typeof url !== "string" || !url.trim())
    )) {
      return apiError(req, `人物参考图须为有效图片地址列表，最多 ${MAX_CHARACTER_REFERENCE_IMAGES} 张`, `Character references must be a list of valid image URLs, up to ${MAX_CHARACTER_REFERENCE_IMAGES} images`, 400);
    }
    const references = (referenceImageUrls as string[] | undefined)?.map((url) => url.trim()) ?? [];
    const appearanceText = typeof appearance === "string" ? appearance.trim() : "";
    if (!appearanceText && references.length === 0) {
      return apiError(req, "请填写外观描述或上传人物参考图后再定妆", "Describe the presenter or upload reference images before generating the sheet", 400);
    }
    if (!providerName || !model) {
      return apiError(req, "缺少 provider / model", "Missing provider / model", 400);
    }
    if (!apiKey) {
      return apiError(req, "缺少 API Key，请先在设置中配置生图平台", "Missing API key — configure an image provider in settings first", 400);
    }
    const referenceModel = resolveCharacterReferenceModel(providerName, model, references.length);
    if (!referenceModel.ok) {
      return apiError(req, referenceModel.error, referenceModel.errorEn, 400);
    }

    // Do not discard a failed reference or fall back to text-only generation: that
    // would charge for a new face rather than the person the user uploaded.
    const usableReferences: string[] = [];
    for (const [index, reference] of references.entries()) {
      let usable: string | undefined;
      try {
        usable = await toRemoteUsableImage(reference);
      } catch {
        // Some providers/helpers may throw for unreadable local files.
      }
      if (!usable || !/^(?:https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*)$/i.test(usable)) {
        return apiError(req, `第 ${index + 1} 张人物参考图不可用，请重新上传后再定妆`, `Character reference image ${index + 1} is unavailable. Upload it again before generating the sheet`, 400);
      }
      usableReferences.push(usable);
    }

    const hasReferences = usableReferences.length > 0;
    const prompt = buildCharacterSheetPrompt(appearanceText, name, usableReferences.length);
    // Provider-specific extras may otherwise overwrite the protected model,
    // prompt or reference arrays after validation inside the provider itself.
    const extra = options?.extra && typeof options.extra === "object" && !Array.isArray(options.extra)
      ? { ...options.extra as Record<string, unknown> }
      : {};
    for (const key of ["model", "modelId", "mode", "prompt", "image", "images", "image_url", "image_urls", "ref_img", "referenceImageUrl", "referenceImageUrls"]) {
      delete extra[key];
    }
    const provider = createProvider({ name: providerName, apiKey, baseUrl: baseUrl ?? "" });
    const result = await provider.generateImage({
      ...(options ?? {}),
      extra,
      modelId: referenceModel.modelId,
      mode: hasReferences ? "image-to-image" : "text-to-image",
      prompt,
      // Override any stale references supplied through advanced options.
      referenceImageUrls: hasReferences ? usableReferences : undefined,
      referenceImageUrl: usableReferences[0],
    });
    const sourceUrl = result.imageUrls?.[0];
    if (!sourceUrl) throw new Error("生图未返回图片");

    // persist into uploads/characters — served via /api/files/characters/<file>
    const dir = join(getDataDir(), "uploads", "characters");
    await mkdir(dir, { recursive: true });
    let buf: Buffer;
    let ext = "png";
    if (sourceUrl.startsWith("data:")) {
      const comma = sourceUrl.indexOf(",");
      if (comma === -1) throw new Error("无法解析 data URI 图片");
      buf = Buffer.from(sourceUrl.slice(comma + 1), "base64");
      const meta = sourceUrl.slice(5, comma);
      if (meta.includes("webp")) ext = "webp";
      else if (meta.includes("jpeg") || meta.includes("jpg")) ext = "jpg";
    } else if (/^https?:\/\//.test(sourceUrl)) {
      const resp = await fetch(sourceUrl);
      if (!resp.ok) throw new Error(`下载定妆图失败: ${resp.status}`);
      buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("webp")) ext = "webp";
      else if (ct.includes("jpeg") || ct.includes("jpg")) ext = "jpg";
    } else {
      throw new Error("不支持的图片来源");
    }
    const fileName = `sheet-${Date.now()}.${ext}`;
    await writeFile(join(dir, fileName), buf);

    return NextResponse.json({ url: `/api/files/characters/${fileName}`, prompt });
  } catch (error) {
    console.error("多视图定妆生成失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : errText(req, "多视图定妆生成失败", "Character sheet generation failed") },
      { status: 500 }
    );
  }
}
