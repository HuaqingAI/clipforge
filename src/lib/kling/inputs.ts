import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, copyFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { getDataDir, getUploadsDir } from "@/lib/paths";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { KlingError } from "./errors";
import { downloadPublicFile } from "./download";
import type { KlingInputSnapshot } from "./job-schema";
import type { KlingParameter, KlingVideoModelDescriptor } from "./types";
import { validateVideoPrompt } from "@/lib/video-prompt";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** CLI 0.2.0 uploads WebP as-is, but Kling's upload service rejects it. */
async function convertWebpToPng(source: string, target: string): Promise<Buffer> {
  try {
    await execFileAsync(ffmpegBin(), [
      "-nostdin", "-y", "-v", "error", "-i", source,
      "-map", "0:v:0", "-frames:v", "1", "-c:v", "png",
      "-fs", String(MAX_IMAGE_BYTES + 1), target,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    if ((await stat(target)).size > MAX_IMAGE_BYTES) {
      throw new KlingError("KLING_INPUT_INVALID", "WebP 转换后的 PNG 图片超过 20 MiB 上限，请缩小图片后重试", 422);
    }
    const bytes = await readFile(target);
    const metadata = await probeMedia(target);
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || !metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384) {
      throw new Error("Invalid converted image");
    }
    return bytes;
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    if (error instanceof KlingError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new KlingError("KLING_MEDIA_TOOL_UNAVAILABLE", "未找到 FFmpeg 或 FFprobe，无法转换 WebP 图片，请先配置媒体工具", 422);
    }
    throw new KlingError("KLING_INPUT_INVALID", "WebP 图片无法转换为 Kling 支持的 PNG 格式，请重新上传 PNG 或 JPEG 图片", 422);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest("hex");
}
const ALIASES: Record<string, string[]> = {
  duration: ["duration", "duration_seconds", "durationSeconds", "duration_sec"],
  aspectRatio: ["aspectRatio", "aspect_ratio", "ratio"],
  resolution: ["resolution", "quality"],
  negativePrompt: ["negativePrompt", "negative_prompt"],
  audioEnabled: ["audioEnabled", "audio_enabled", "generate_audio", "sound"],
  seed: ["seed"], fps: ["fps", "frame_rate"], guidanceScale: ["guidanceScale", "guidance_scale", "cfg_scale"],
  motionStrength: ["motionStrength", "motion_strength"],
};
const RESERVED_ARGUMENTS = new Set(["model", "prompt", "image", "tailImage", "poll", "quiet", "base-url", "task-trace-id"]);

export function normalizeVideoParameters(model: KlingVideoModelDescriptor, source: Record<string, unknown>, minimumDuration?: number): Record<string, string | number | boolean> {
  if (minimumDuration !== undefined) {
    const duration = model.parameters.find((parameter) => ALIASES.duration.includes(parameter.name));
    if (!Number.isFinite(minimumDuration) || minimumDuration <= 0 || !duration) throw new KlingError("TIDEWE_NATIVE_DURATION_UNSUPPORTED", "当前模型没有可核验的时长参数，不能保证完整英语口播。", 422);
    const explicit = ALIASES.duration.map((name) => source[name]).filter((value) => value !== undefined && value !== null && value !== "");
    if (new Set(explicit.map(String)).size > 1) throw new KlingError("KLING_INPUT_INVALID", "同一镜头不能设置相互冲突的时长参数。", 422);
    const requested = Number(explicit[0] ?? duration.default ?? minimumDuration);
    if (!Number.isFinite(requested) || requested <= 0) throw new KlingError("TIDEWE_NATIVE_DURATION_UNSUPPORTED", "口播镜头的生成时长无效。", 422);
    const wanted = Math.max(requested, minimumDuration);
    const declared = duration.allowedValues ?? (duration.type === "number" ? undefined : duration.default !== undefined ? [duration.default] : []);
    const covering = declared
      ? declared.filter((value) => Number.isFinite(Number(value)) && Number(value) >= wanted).sort((left, right) => Number(left) - Number(right))[0]
      : Math.ceil(wanted);
    if (covering === undefined) throw new KlingError("TIDEWE_NATIVE_DURATION_UNSUPPORTED", `当前模型的时长档位无法覆盖 ${minimumDuration} 秒英语口播，请更换模型或重新规划镜头。`, 422);
    source = { ...source };
    for (const name of ALIASES.duration) delete source[name];
    source[duration.name] = duration.type === "number" ? Number(covering) : covering;
  }
  const normalized: Record<string, string | number | boolean> = {};
  const validateValue = (parameter: KlingParameter, raw: unknown): string | number | boolean => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(parameter.name) || RESERVED_ARGUMENTS.has(parameter.name)) {
      throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "当前模型声明了不支持的 CLI 参数", 422);
    }
    let value = raw;
    if (parameter.type === "number" && typeof value === "string" && value.trim()) value = Number(value);
    if (typeof value !== parameter.type || (typeof value === "number" && !Number.isFinite(value)) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (parameter.allowedValues && !parameter.allowedValues.includes(value as string | number | boolean))) {
      throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "参数值不受当前模型支持：" + parameter.name, 422);
    }
    if (typeof value === "string" && (value.length > 4096 || value.startsWith("--") || value.includes("\0"))) {
      throw new KlingError("KLING_INPUT_INVALID", "参数内容过长或包含 CLI 无法解析的内容：" + parameter.name, 422);
    }
    return value as string | number | boolean;
  };
  for (const [key, raw] of Object.entries(source)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const parameter = model.parameters.find((item) => item.name === key) ??
      model.parameters.find((item) => ALIASES[key]?.includes(item.name));
    if (!parameter || parameter.name === "prompt" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(parameter.name)) {
      throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "当前模型不支持参数：" + key, 422);
    }
    const value = validateValue(parameter, raw);
    if (parameter.name in normalized && normalized[parameter.name] !== value) throw new KlingError("KLING_INPUT_INVALID", "同一参数不能同时设置多个不同值：" + parameter.name, 422);
    normalized[parameter.name] = value;
  }
  for (const parameter of model.parameters) {
    if (parameter.name === "prompt") continue;
    if (!(parameter.name in normalized) && parameter.default !== undefined) normalized[parameter.name] = validateValue(parameter, parameter.default);
    if (parameter.required && !(parameter.name in normalized)) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "缺少当前模型必填参数：" + parameter.name, 422);
  }
  return normalized;
}

async function safeLocalImage(source: string): Promise<string> {
  if (!source.startsWith("/api/files/")) throw new KlingError("KLING_INPUT_INVALID", "仅允许已上传的图片或公网图片地址", 422);
  let decoded: string;
  try { decoded = decodeURIComponent(source.slice("/api/files/".length)); }
  catch { throw new KlingError("KLING_INPUT_INVALID", "图片路径编码无效", 422); }
  if (decoded.includes("\0")) throw new KlingError("KLING_INPUT_INVALID", "图片路径无效", 422);
  try {
    const root = await realpath(getUploadsDir());
    const candidate = await realpath(resolve(root, decoded));
    const child = relative(root, candidate);
    if (!child || child.startsWith("..") || isAbsolute(child) || !(await stat(candidate)).isFile()) {
      throw new KlingError("KLING_INPUT_INVALID", "图片不在本机素材目录内", 422);
    }
    return candidate;
  } catch (error) {
    if (error instanceof KlingError) throw error;
    throw new KlingError("KLING_INPUT_INVALID", "原始图片不存在或无法读取，请重新上传后再生成", 422);
  }
}

/** Validate roles and bytes before the CLI can upload anything. */
export async function prepareKlingInputs(jobId: string, model: KlingVideoModelDescriptor, refs: Array<{ role: "image" | "tailImage"; sourceUrl: string }>): Promise<KlingInputSnapshot[]> {
  if (model.tool === "text_to_video" && refs.length) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "文生视频不能混入图片", 422);
  if (model.tool === "image_to_video" && !refs.length) throw new KlingError("KLING_INPUT_INVALID", "图生视频需要首帧图片", 422);
  if (refs.some((ref) => ref.role === "tailImage") && !model.capabilities.tailFrame) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "当前模型未验证尾帧能力，请关闭首尾帧衔接", 422);
  const ordinary = refs.filter((ref) => ref.role === "image");
  const tails = refs.filter((ref) => ref.role === "tailImage");
  if (refs.some((ref) => ref.role !== "image" && ref.role !== "tailImage") || (model.tool === "image_to_video" && ordinary.length === 0) || tails.length > 1) {
    throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "图生视频必须有首帧，且最多使用一张尾帧图片", 422);
  }
  for (const role of ["image", "tailImage"] as const) {
    const count = refs.filter((ref) => ref.role === role).length;
    const slots = model.inputSlots.filter((slot) => slot.role === role);
    if (count < slots.filter((slot) => slot.required).length || count > slots.length) {
      throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "图片角色不符合当前模型的输入声明：" + role, 422);
    }
  }
  if (ordinary.length > 1 && !model.capabilities.multiImage) throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "当前模型不支持该多参考图组合", 422);
  if (refs.length > Math.max(1, model.inputSlots.length) || model.inputSlots.filter((slot) => slot.required).length > refs.length) {
    throw new KlingError("KLING_CAPABILITY_UNSUPPORTED", "图片数量不符合当前模型的输入声明", 422);
  }
  const directory = join(getDataDir(), "integrations", "kling", "jobs", jobId, "inputs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshots: KlingInputSnapshot[] = [];
  for (const [index, ref] of refs.entries()) {
    const source = ref.sourceUrl;
    const temporary = join(directory, index + ".input");
    let imagePath = temporary;
    if (source.startsWith("/api/files/")) {
      const local = await safeLocalImage(source);
      if ((await stat(local)).size > 20 * 1024 * 1024) throw new KlingError("KLING_INPUT_INVALID", "图片超过 20 MiB 上限", 422);
      await copyFile(local, temporary);
    } else if (source.startsWith("data:")) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
      if (!match || match[2].length > 28 * 1024 * 1024) throw new KlingError("KLING_INPUT_INVALID", "图片 data URI 无效或过大", 422);
      await writeFile(temporary, Buffer.from(match[2], "base64"), { mode: 0o600 });
    } else if (/^https?:\/\//.test(source)) {
      await downloadPublicFile(source, temporary, 20 * 1024 * 1024);
    } else throw new KlingError("KLING_INPUT_INVALID", "无法读取图片来源", 422);
    let bytes: Buffer = await readFile(temporary);
    if (bytes.length > MAX_IMAGE_BYTES) throw new KlingError("KLING_INPUT_INVALID", "图片超过 20 MiB 上限", 422);
    const extension = bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? ".png" :
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? ".jpg" :
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? ".webp" : "";
    if (!extension || !bytes.length) throw new KlingError("KLING_INPUT_INVALID", "首帧或参考图不是有效的 PNG、JPEG、WebP 图片", 422);
    const metadata = await probeMedia(temporary).catch((error: NodeJS.ErrnoException) => {
      throw new KlingError(error.code === "ENOENT" ? "KLING_MEDIA_TOOL_UNAVAILABLE" : "KLING_INPUT_INVALID", error.code === "ENOENT" ? "未找到 FFprobe，请先配置媒体工具" : "图片无法解码，请检查首帧或参考图", 422);
    });
    if (!metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384) throw new KlingError("KLING_INPUT_INVALID", "图片尺寸无效或过大", 422);
    const sourceHash = contentHash(bytes);
    imagePath = join(directory, index + (extension === ".webp" ? ".png" : extension));
    if (extension === ".webp") {
      try { bytes = await convertWebpToPng(temporary, imagePath); }
      finally { await rm(temporary, { force: true }); }
    } else {
      await rename(temporary, imagePath);
    }
    snapshots.push({ ...ref, path: imagePath, hash: contentHash(bytes), size: bytes.length, ...(extension === ".webp" ? { sourceHash } : {}) });
  }
  return snapshots;
}

export function buildKlingVideoArguments(model: KlingVideoModelDescriptor, prompt: string, options: Record<string, string | number | boolean>, inputs: KlingInputSnapshot[], jobId: string): string[] {
  assertValidKlingPrompt(prompt);
  if (!model.remoteModelId.trim() || model.remoteModelId.length > 256 || model.remoteModelId.startsWith("--") || /[\x00-\x1f]/.test(model.remoteModelId)) {
    throw new KlingError("KLING_INPUT_INVALID", "模型 ID 无法安全传给当前 CLI", 422);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(jobId)) throw new KlingError("KLING_INPUT_INVALID", "本地任务标识无效", 422);
  const normalized = normalizeVideoParameters(model, options);
  const args = [model.tool, "--model", model.remoteModelId, "--quiet", "--task-trace-id", jobId];
  for (const input of inputs) args.push(input.role === "tailImage" ? "--tailImage" : "--image", input.path);
  for (const [key, value] of Object.entries(normalized)) args.push("--" + key, String(value));
  args.push(prompt);
  if (args.reduce((sum, arg) => sum + arg.length * 2 + 4, 0) > 28000) throw new KlingError("KLING_INPUT_INVALID", "命令参数过长，请缩短提示词", 422);
  return args;
}

/** Do not rewrite a prompt after its billing confirmation; reject actionable issues instead. */
export function assertValidKlingPrompt(prompt: string): void {
  const issues = validateVideoPrompt(prompt);
  if (issues.length) throw new KlingError("KLING_PROMPT_INVALID", issues.map((issue) => issue.message).join(" "), 422);
}
