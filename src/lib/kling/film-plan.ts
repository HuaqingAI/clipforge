import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, projects, scripts, type Shot } from "@/lib/db/schema";
import { filterAssetsForScript, scriptRevision } from "@/lib/asset-context";
import { getDataDir, getOutputDir, getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { buildShotVideoPrompt, normalizeVideoPromptSettings, type VideoPromptSettings } from "@/lib/shot-video-prompt";
import { checkPromptConsistency, sanitizeCreativeIntent, sanitizeVisualBible } from "@/lib/production-system";
import { validateVideoPrompt } from "@/lib/video-prompt";
import { withVideoAudioMode, type VideoAudioMode } from "@/lib/video-audio";
import { DEFAULT_FREE_VOICE } from "@/lib/tts-voices";
import { MAX_DOWNLOAD_BYTES } from "@/lib/providers/stock-types";
import { getProfile } from "./profiles";
import { refreshProfile } from "./auth";
import { KlingError } from "./errors";
import { record } from "./protocol";
import { contentHash, normalizeVideoParameters, prepareKlingInputs, buildKlingVideoArguments } from "./inputs";
import { downloadPublicFile } from "./download";
import { klingFilmRuns, klingFilmShots, type KlingFilmRun, type KlingFilmShot, type KlingFilmShotData } from "./film-schema";
import { getKlingFilm, getKlingFilmShots, klingFilmView } from "./film-repository";
import { klingJobs, klingJobOutputs } from "./job-schema";
import { KLING_AUDIO_PARAMETER_NAMES, klingModelOptions } from "./model-options";
import { isKlingRuntimeEnabled } from "./runtime";
import type { KlingFilmOutputSettings, KlingFilmView } from "./film-types";
import type { KlingParameter, KlingVideoModelDescriptor } from "./types";
import type { KlingSubmitRequest } from "./job-types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VIDEO = /\.(?:mp4|webm|mov|m4v|mkv)(?:$|[?#])/i;
const DURATION_NAMES = ["duration", "duration_seconds", "durationSeconds", "duration_sec"];
const ASPECT_NAMES = ["aspect_ratio", "aspectRatio", "ratio"];
const AUDIO_NAMES = KLING_AUDIO_PARAMETER_NAMES;
const MAX_SHOTS = 50, MAX_SECONDS = 600, PLAN_TTL_MS = 15 * 60_000;
function fail(code: string, message: string): KlingError { return new KlingError(code, message, 409); }
function childPath(root: string, file: string): boolean {
  const child = relative(root, file);
  return !!child && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child);
}
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function localMediaPath(url: string): Promise<string> {
  const root = url.startsWith("/api/files/") ? getUploadsDir() : url.startsWith("/api/output/") ? getOutputDir() : undefined;
  const prefix = url.startsWith("/api/files/") ? "/api/files/" : "/api/output/";
  if (!root) throw fail("KLING_FILM_LOCAL_VIDEO_REQUIRED", "只能复用已保存到本机的镜头视频。");
  try {
    const suffix = decodeURIComponent(url.slice(prefix.length));
    if (!suffix || /[\0?#]/.test(suffix)) throw new Error("Invalid route");
    const actualRoot = await realpath(root);
    const file = await realpath(resolve(actualRoot, suffix));
    const info = await stat(file);
    if (!childPath(actualRoot, file) || !info.isFile() || info.size <= 0 || info.size > MAX_DOWNLOAD_BYTES) throw new Error("Invalid media");
    return file;
  } catch { throw fail("KLING_FILM_SOURCE_CHANGED", "原始素材已丢失、不可读或不在允许的本机素材目录中。"); }
}
function outputSettings(raw: unknown): KlingFilmOutputSettings {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw fail("KLING_FILM_OUTPUT_INVALID", "整片输出设置必须是对象。");
  const value = record(raw);
  const settings = { resolution: value.resolution ?? "720p", aspectRatio: value.aspectRatio ?? "9:16", audioStrategy: value.audioStrategy ?? "edge-tts", voice: value.voice ?? DEFAULT_FREE_VOICE, subtitles: value.subtitles ?? true };
  if (!["720p", "1080p"].includes(String(settings.resolution)) || !["9:16", "16:9", "1:1"].includes(String(settings.aspectRatio)) || !["edge-tts", "edge-tts-mix", "native"].includes(String(settings.audioStrategy)) || typeof settings.subtitles !== "boolean" || typeof settings.voice !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(settings.voice)) throw fail("KLING_FILM_OUTPUT_INVALID", "整片分辨率、画幅、配音或字幕设置无效。");
  return settings as KlingFilmOutputSettings;
}
function audioValue(parameter: KlingParameter, enabled: boolean): string | number | boolean {
  const choices = parameter.allowedValues ?? (parameter.type === "boolean" ? [true, false] : parameter.default !== undefined ? [parameter.default] : []);
  const wanted = new Set(enabled ? ["true", "on", "yes", "1", "enabled", "enable"] : ["false", "off", "no", "0", "disabled", "disable"]);
  const value = choices.find((choice) => wanted.has(String(choice).toLowerCase()));
  if (value === undefined) throw fail("KLING_FILM_AUDIO_UNSUPPORTED", `当前模型未明确声明${enabled ? "开启" : "关闭"}原生音频的参数值，请更换音频策略或模型。`);
  return value;
}
function generationOptions(model: KlingVideoModelDescriptor, raw: Record<string, unknown>, output: KlingFilmOutputSettings, seconds: number, negativePrompt: string): { options: Record<string, string | number | boolean>; duration: number } {
  const duration = model.parameters.find((item) => DURATION_NAMES.includes(item.name));
  if (!duration) throw fail("KLING_FILM_DURATION_UNSUPPORTED", "当前模型没有可核验的视频时长声明，不能自动编排整片。");
  const source = { ...raw };
  const explicitValues = DURATION_NAMES.map((name) => raw[name]).filter((value) => value !== undefined && value !== "");
  if (new Set(explicitValues.map(String)).size > 1) throw fail("KLING_FILM_DURATION_UNSUPPORTED", "同一镜头不能设置相互冲突的时长参数。");
  const explicit = explicitValues[0];
  const declared = duration.allowedValues?.length ? duration.allowedValues : duration.default !== undefined ? [duration.default] : [];
  const candidates = declared.map((value) => ({ value, seconds: Number(value) })).filter((item) => Number.isFinite(item.seconds) && item.seconds > 0 && item.seconds >= seconds).sort((a, b) => a.seconds - b.seconds);
  let chosen = explicit !== undefined ? declared.find((value) => String(value) === String(explicit)) : candidates[0]?.value;
  if (chosen === undefined || !Number.isFinite(Number(chosen)) || Number(chosen) < seconds) throw fail("KLING_FILM_DURATION_UNSUPPORTED", `模型已声明的时长不能覆盖 ${seconds} 秒镜头，已阻止截短或猜测时长。`);
  if (duration.type === "number") chosen = Number(chosen);
  for (const name of DURATION_NAMES) delete source[name];
  source[duration.name] = chosen;
  const aspect = model.parameters.find((item) => ASPECT_NAMES.includes(item.name));
  if (aspect && !ASPECT_NAMES.some((name) => source[name] !== undefined)) source[aspect.name] = output.aspectRatio;
  const audio = model.parameters.find((item) => AUDIO_NAMES.includes(item.name));
  if (audio) { for (const name of AUDIO_NAMES) delete source[name]; source[audio.name] = audioValue(audio, output.audioStrategy !== "edge-tts"); }
  else if (output.audioStrategy === "native") throw fail("KLING_FILM_AUDIO_UNSUPPORTED", "当前模型没有已适配的原生音频参数，请使用后期免费配音。");
  const negativeParameter = model.parameters.find((parameter) => ["negative_prompt", "negativePrompt"].includes(parameter.name));
  if (negativePrompt && negativeParameter) {
    const existing = [source.negative_prompt, source.negativePrompt].filter((value) => value !== undefined && value !== null && value !== "");
    if (existing.some((value) => typeof value !== "string")) throw fail("KLING_FILM_INPUT_INVALID", "负面提示词必须是文本。");
    if (new Set(existing).size > 1) throw fail("KLING_FILM_INPUT_INVALID", "同一镜头不能设置相互冲突的负面提示词。");
    const mapped = klingModelOptions({ ...model, parameters: [negativeParameter] }, { negativePrompt: [...existing.slice(0, 1), negativePrompt].join(", ") });
    if (mapped.unsupportedSettings.length) throw fail("KLING_FILM_PROMPT_INVALID", "当前模型不支持项目的负面提示词设置。");
    delete source.negative_prompt; delete source.negativePrompt;
    Object.assign(source, mapped.options);
  }
  return { options: normalizeVideoParameters(model, source), duration: Number(chosen) };
}
function projectPromptRevision(project: typeof projects.$inferSelect): string {
  return contentHash({ category: project.productCategory ?? null, creativeIntent: sanitizeCreativeIntent(project.creativeIntent), visualBible: sanitizeVisualBible(project.visualBible) });
}
function promptFor(shot: Shot, model: KlingVideoModelDescriptor, output: KlingFilmOutputSettings, ordinal: number, project: typeof projects.$inferSelect, settings: VideoPromptSettings): { prompt: string; negativePrompt: string } {
  const audioMode: VideoAudioMode = output.audioStrategy === "edge-tts" ? "silent" : output.audioStrategy === "edge-tts-mix" ? "ambient" : "native";
  const direction = buildShotVideoPrompt({ shot, ordinal, settings, category: project.productCategory, creativeIntent: project.creativeIntent, visualBible: project.visualBible });
  const parts = model.tool === "text_to_video" ? [shot.prompt?.trim() || shot.description, direction.prompt] : [direction.prompt];
  if (output.audioStrategy === "native" && shot.voiceover?.trim()) parts.push(`原生音频必须逐字说出以下台词，不改写、不增添：${JSON.stringify(shot.voiceover.trim())}`);
  // Normalize legacy audio templates in both saved text-to-video prompts and motion text.
  const prompt = withVideoAudioMode(parts.join("\n"), audioMode);
  const issues = validateVideoPrompt(prompt);
  if (issues.length) throw fail("KLING_FILM_PROMPT_INVALID", `镜头 ${shot.shotId}：${issues.map((issue) => issue.message).join(" ")}`);
  const conflict = checkPromptConsistency(prompt, sanitizeVisualBible(project.visualBible)).find((issue) => issue.severity === "fail");
  if (conflict) throw fail("KLING_FILM_PROMPT_INVALID", `镜头 ${shot.shotId} 的提示词违反项目一致性要求：${conflict.anchor}`);
  return { prompt, negativePrompt: direction.negativePrompt };
}
type Asset = typeof assets.$inferSelect;
function keyframe(asset: Asset | undefined, shot: Shot, productImages: string[] | null): string | undefined {
  if (asset?.status === "done") {
    if (asset.sourceKeyframeUrl) return asset.sourceKeyframeUrl;
    if (asset.filePath && !VIDEO.test(asset.filePath)) return asset.filePath;
    if (asset.provider !== "kling-cli" && asset.thumbnailPath && !VIDEO.test(asset.thumbnailPath)) return asset.thumbnailPath;
  }
  return shot.visualSource === "product_image" ? productImages?.[0] : undefined;
}

/** Build a frozen, reviewable plan. This function never invokes a generation command. */
export async function previewKlingFilm(raw: unknown): Promise<KlingFilmView> {
  if (!isKlingRuntimeEnabled()) throw new KlingError("KLING_SCOPE_UNSUPPORTED", "Kling 整片编排仅支持本机网页版", 503);
  const body = record(raw);
  let promptSettings: VideoPromptSettings;
  try { promptSettings = normalizeVideoPromptSettings(body.promptSettings); }
  catch (error) { throw fail("KLING_FILM_PROMPT_SETTINGS_INVALID", error instanceof Error ? error.message : "视频提示词设置无效。"); }
  for (const key of ["projectId", "scriptId", "profileId"]) if (typeof body[key] !== "string" || !ID.test(body[key])) throw fail("KLING_FILM_INPUT_INVALID", "整片计划缺少有效参数：" + key);
  if (typeof body.selectionKey !== "string" || body.selectionKey.length > 1024 || (body.options !== undefined && (!body.options || typeof body.options !== "object" || Array.isArray(body.options))) || (body.reuseExistingVideos !== undefined && typeof body.reuseExistingVideos !== "boolean")) throw fail("KLING_FILM_INPUT_INVALID", "整片模型、参数或复用设置无效。");
  let profile = getProfile(body.profileId as string);
  if (profile.environmentState !== "ready" || profile.disabledAt) throw fail("KLING_ENVIRONMENT_REQUIRED", "请先检测 Kling CLI 本机环境。");
  if (profile.authState !== "authenticated" || !profile.principalKey) throw new KlingError("KLING_LOGIN_REQUIRED", "请先登录并核验 Kling 原账号。", 401);
  if (!profile.catalogCheckedAt || Date.now() - profile.catalogCheckedAt > 300_000) profile = await refreshProfile(profile.id, undefined, { credits: false });
  if (profile.authState !== "authenticated" || !profile.principalKey) throw new KlingError("KLING_LOGIN_REQUIRED", "请先登录并核验 Kling 原账号。", 401);
  const model = profile.catalogSnapshot.find((item) => item.selectionKey === body.selectionKey);
  if (!model?.available) throw fail("KLING_MODEL_UNAVAILABLE", model?.disabledReason ?? "当前账号没有选择的可用视频模型。");
  if (model.inputSlots.filter((slot) => slot.required && slot.role === "image").length > 1 || model.inputSlots.some((slot) => slot.required && slot.role === "tailImage")) throw fail("KLING_FILM_MODEL_UNSUPPORTED", "当前整片编排只使用每镜头一张关键帧，此模型要求其他必填图片输入。");
  const output = outputSettings(body.output);
  if (output.audioStrategy === "native" && !model.capabilities.audio) throw fail("KLING_FILM_AUDIO_UNSUPPORTED", "当前模型未声明原生音频能力，请选择免费配音。");
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, body.projectId as string)).get();
  if (!project) throw fail("KLING_PROJECT_NOT_FOUND", "项目不存在。");
  const scriptRows = db.select().from(scripts).where(eq(scripts.projectId, project.id)).all();
  const script = scriptRows.find((item) => item.selected) ?? scriptRows[0];
  if (!script || script.id !== body.scriptId) throw fail("KLING_CONTEXT_CHANGED", "所选脚本已变化，请刷新后重新预览。");
  const shots = script.shots ?? [];
  if (!shots.length || shots.length > MAX_SHOTS || new Set(shots.map((shot) => shot.shotId)).size !== shots.length || shots.some((shot) => !Number.isSafeInteger(shot.shotId) || shot.shotId < 0 || !Number.isFinite(shot.duration) || shot.duration <= 0) || shots.reduce((sum, shot) => sum + shot.duration, 0) > MAX_SECONDS) throw fail("KLING_FILM_LIMIT_EXCEEDED", "整片需要 1–50 个有效镜头，总时长不能超过 600 秒。");
  const selectedAssets = filterAssetsForScript(db.select().from(assets).where(and(eq(assets.projectId, project.id), eq(assets.selected, true))).all(), script);
  const runId = randomUUID(), now = Date.now(), warnings: string[] = [];
  const planned: Array<typeof klingFilmShots.$inferInsert> = [];
  const reuseExistingVideos = body.reuseExistingVideos !== false;
  let generatedSeconds = 0;
  for (const [ordinal, shot] of shots.entries()) {
    const selected = selectedAssets.filter((asset) => asset.shotId === shot.shotId);
    if (selected.length > 1) throw fail("KLING_CONTEXT_CHANGED", `镜头 ${shot.shotId} 有多个选中素材，请先明确选择一个版本。`);
    const asset = selected[0];
    const direction = promptFor(shot, model, output, ordinal, project, promptSettings);
    const data: KlingFilmShotData = { shot: structuredClone(shot), source: "generate", prompt: direction.prompt, options: {}, missingKeyframe: false, inputs: [], baselineAssetId: asset?.id ?? null, attempt: 0 };
    let assetId: string | null = null;
    if (reuseExistingVideos && asset?.status === "done" && asset.filePath && VIDEO.test(asset.filePath)) {
      try {
        const file = await localMediaPath(asset.filePath), before = await fileHash(file), metadata = await probeMedia(file);
        if (!Number.isFinite(metadata.duration) || metadata.duration + 0.1 < shot.duration || !Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) || metadata.width <= 0 || metadata.height <= 0 || await fileHash(file) !== before) throw new Error("Invalid video");
        if (output.audioStrategy === "native" && shot.voiceover?.trim() && !metadata.hasAudio) throw fail("KLING_FILM_AUDIO_UNSUPPORTED", `镜头 ${shot.shotId} 的已有视频没有音轨，不能满足本次原生对白设置。`);
        Object.assign(data, { source: "reuse", sourceFileHash: before, sourceFilePath: file, videoUrl: asset.filePath }); assetId = asset.id;
        if (output.audioStrategy !== "edge-tts" && Math.abs(metadata.duration - shot.duration) > 0.1) warnings.push(`镜头 ${shot.shotId} 复用视频的实际时长为 ${Number(metadata.duration.toFixed(2))} 秒；${output.audioStrategy === "native" ? "原声音" : "叠加配音"}策略将保留完整视频和音轨，不截为脚本的 ${shot.duration} 秒。`);
      } catch (error) {
        if (error instanceof KlingError && error.code === "KLING_FILM_AUDIO_UNSUPPORTED") throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && /ffprobe|spawn/i.test(error instanceof Error ? error.message : "")) throw fail("KLING_MEDIA_TOOL_UNAVAILABLE", "FFprobe 不可用，请先配置本机媒体工具。");
        warnings.push(`镜头 ${shot.shotId} 的已有视频不能安全复用，本次计划将重新生成。`);
      }
    }
    if (data.source === "generate") {
      const generated = generationOptions(model, record(body.options), output, shot.duration, direction.negativePrompt);
      data.options = generated.options; data.generationDuration = generated.duration; generatedSeconds += generated.duration;
      if (model.tool === "image_to_video") {
        data.keyframeUrl = keyframe(asset, shot, project.productImages);
        data.missingKeyframe = !data.keyframeUrl;
        if (data.keyframeUrl) data.inputs = await prepareKlingInputs(`film-${runId}-${ordinal}`, model, [{ role: "image", sourceUrl: data.keyframeUrl }]);
      }
      if (!data.missingKeyframe) buildKlingVideoArguments(model, data.prompt, data.options, data.inputs, `film-${runId}-${ordinal}`);
      if (generated.duration !== shot.duration) warnings.push(output.audioStrategy !== "edge-tts"
        ? `镜头 ${shot.shotId} 将生成 ${generated.duration} 秒视频；${output.audioStrategy === "native" ? "原声音" : "叠加配音"}策略将按返回视频的实际完整时长合成，保留完整音轨，不截为脚本的 ${shot.duration} 秒。${output.audioStrategy === "edge-tts-mix" ? "免费旁白较长时会延长镜头，完整保留台词。" : ""}`
        : `镜头 ${shot.shotId} 将生成 ${generated.duration} 秒视频，合成时以脚本 ${shot.duration} 秒为基准；免费旁白较长时会延长镜头，完整保留台词。`);
    }
    planned.push({ id: randomUUID(), runId, shotId: shot.shotId, ordinal, status: data.source === "reuse" ? "ready" : "waiting", jobId: null, assetId, data, updatedAt: now });
  }
  if (generatedSeconds > MAX_SECONDS) throw fail("KLING_FILM_LIMIT_EXCEEDED", "按模型支持时长计算，本批付费生成总时长超过 600 秒，请拆分脚本。");
  const snapshot = { shots: structuredClone(shots), ...(script.characters ? { characters: structuredClone(script.characters) } : {}) };
  const revision = scriptRevision(script);
  const projectRevision = projectPromptRevision(project);
  const planHash = contentHash({ projectId: project.id, scriptId: script.id, scriptRevision: revision, script: snapshot, profileId: profile.id, principalKey: profile.principalKey, model, output, promptSettings, projectPromptRevision: projectRevision, reuseExistingVideos,
    shots: planned.map(({ shotId, ordinal, assetId, data }) => ({ shotId, ordinal, assetId, source: data.source, prompt: data.prompt, options: data.options, generationDuration: data.generationDuration, baselineAssetId: data.baselineAssetId, keyframeUrl: data.keyframeUrl, missingKeyframe: data.missingKeyframe, sourceFileHash: data.sourceFileHash, videoUrl: data.videoUrl, inputs: data.inputs.map(({ role, hash, sourceHash, sourceUrl }) => ({ role, hash, ...(sourceHash ? { sourceHash } : {}), sourceUrl })) })) });
  const run: KlingFilmRun = { id: runId, projectId: project.id, scriptId: script.id, profileId: profile.id, principalKey: profile.principalKey!, clientRequestId: null, status: "draft", leaseOwner: null, leaseExpiresAt: null,
    data: { scriptRevision: revision, scriptSnapshot: snapshot, model: structuredClone(model), output, promptSettings, projectPromptRevision: projectRevision, planHash, expiresAt: now + PLAN_TTL_MS, reuseExistingVideos, warnings, stage: "计划待确认", authorizationEpoch: 0 }, createdAt: now, updatedAt: now };
  db.transaction((tx) => { assertContext(run, planned as KlingFilmShot[]); tx.insert(klingFilmRuns).values(run).run(); for (const item of planned) tx.insert(klingFilmShots).values(item).run(); });
  return klingFilmView(run);
}

function assertContext(run: KlingFilmRun, shots: KlingFilmShot[]): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  if (!project) throw fail("KLING_PROJECT_NOT_FOUND", "整片所属项目已不存在，已停止后续生成。");
  if (run.data.projectPromptRevision && run.data.projectPromptRevision !== projectPromptRevision(project)) throw fail("KLING_CONTEXT_CHANGED", "项目的视觉方向或一致性要求已变化，请重新预览整片计划。");
  const rows = db.select().from(scripts).where(eq(scripts.projectId, run.projectId)).all();
  const script = rows.find((item) => item.selected) ?? rows[0];
  if (!script || script.id !== run.scriptId || scriptRevision(script) !== run.data.scriptRevision || shots.length !== (script.shots?.length ?? 0)) throw fail("KLING_CONTEXT_CHANGED", "整片脚本已变化，请停止原计划并重新预览。");
  const active = filterAssetsForScript(db.select().from(assets).where(and(eq(assets.projectId, run.projectId), eq(assets.selected, true))).all(), script);
  for (const shot of shots) {
    if (shot.ordinal < 0 || contentHash(script.shots?.[shot.ordinal]) !== contentHash(shot.data.shot)) throw fail("KLING_CONTEXT_CHANGED", "整片镜头顺序或内容已变化。");
    const selected = active.filter((asset) => asset.shotId === shot.shotId);
    const expected = shot.status === "ready" ? shot.assetId : shot.data.baselineAssetId;
    let matches = selected.length <= 1 && (selected[0]?.id ?? null) === (expected ?? null);
    // A generic child importer may finish immediately before the FilmRun adopts its ready result.
    if (!matches && shot.status !== "ready" && shot.jobId && selected.length === 1) {
      const job = db.select().from(klingJobs).where(eq(klingJobs.id, shot.jobId)).get();
      if (job?.data.filmRunId === run.id && job.data.filmShotId === shot.id) matches = db.select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, job.id)).all().some((output) => output.importState === "imported" && output.assetId === selected[0].id);
    }
    if (!matches) throw fail("KLING_CONTEXT_CHANGED", `镜头 ${shot.shotId} 当前选中的素材已变化，请重新预览整片计划。`);
  }
}
export function assertKlingFilmContext(runId: string): void { assertContext(getKlingFilm(runId), getKlingFilmShots(runId)); }

async function sourceHash(source: string, runId: string): Promise<string> {
  if (source.startsWith("/api/files/") || source.startsWith("/api/output/")) return fileHash(await localMediaPath(source));
  if (source.startsWith("data:")) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
    if (!match || match[1].length > 28 * 1024 * 1024) throw new Error("Invalid input");
    return contentHash(Buffer.from(match[1], "base64"));
  }
  const directory = join(getDataDir(), "integrations", "kling", "films", runId, "verify"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, randomUUID() + ".input");
  try { await downloadPublicFile(source, temporary, 20 * 1024 * 1024); return await fileHash(temporary); }
  finally { await unlink(temporary).catch(() => {}); }
}
/** Recheck originals and their private snapshots. Generated ready videos are checked through their new frozen source. */
export async function verifyKlingFilmFiles(runId: string): Promise<void> {
  const shots = getKlingFilmShots(runId); getKlingFilm(runId);
  for (const shot of shots) {
    // A completed clip can be composed even if its former remote keyframe expires later.
    for (const input of shot.status === "ready" ? [] : shot.data.inputs) {
      try {
        const actual = await realpath(input.path), root = await realpath(join(getDataDir(), "integrations", "kling", "jobs"));
        if (!childPath(root, actual) || await fileHash(actual) !== input.hash || await sourceHash(input.sourceUrl, runId) !== (input.sourceHash ?? input.hash)) throw new Error("Input changed");
      } catch { throw fail("KLING_INPUT_CHANGED", `镜头 ${shot.shotId} 的原始关键帧或已确认输入快照已改变，请重新预览。`); }
    }
    if (shot.status === "ready" || shot.data.source === "reuse") {
      try {
        if (!shot.data.sourceFilePath || !shot.data.sourceFileHash || !shot.data.videoUrl || await localMediaPath(shot.data.videoUrl) !== await realpath(shot.data.sourceFilePath) || await fileHash(shot.data.sourceFilePath) !== shot.data.sourceFileHash) throw new Error("Video changed");
      } catch { throw fail("KLING_FILM_SOURCE_CHANGED", `镜头 ${shot.shotId} 的已锁定视频已改变或丢失，请恢复原素材。`); }
    }
  }
}

/** Convert one frozen film shot to the existing single-shot contract without creating any paid task. */
export function buildFilmShotJobRequest(run: KlingFilmRun, shot: KlingFilmShot): KlingSubmitRequest {
  if (shot.runId !== run.id || shot.data.source !== "generate" || shot.data.missingKeyframe || !Number.isSafeInteger(shot.data.attempt) || shot.data.attempt < 0) throw fail("KLING_FILM_SHOT_INVALID", "当前镜头不能创建整片生成作业。");
  const clientRequestId = `film-${run.id}-${shot.id}-${shot.data.attempt}`;
  if (!ID.test(clientRequestId)) throw fail("KLING_FILM_SHOT_INVALID", "整片镜头的稳定请求编号无效。");
  const ordinary = shot.data.inputs.filter((input) => input.role === "image"), tail = shot.data.inputs.find((input) => input.role === "tailImage");
  return { provider: "kling-cli", executionScope: "single-shot", profileId: run.profileId, clientRequestId, projectId: run.projectId, scriptId: run.scriptId, shotId: shot.shotId,
    selectionKey: run.data.model.selectionKey, mode: run.data.model.tool === "image_to_video" ? "image-to-video" : "text-to-video", prompt: shot.data.prompt,
    options: { ...shot.data.options }, expectedSelectedAssetId: shot.data.baselineAssetId,
    ...(ordinary[0] ? { imageUrl: ordinary[0].sourceUrl } : {}), ...(ordinary.length > 1 ? { referenceImageUrls: ordinary.slice(1).map((input) => input.sourceUrl) } : {}), ...(tail ? { lastImageUrl: tail.sourceUrl } : {}),
    billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: clientRequestId } };
}
