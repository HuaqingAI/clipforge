import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, rename, unlink, copyFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { assets, projects, scripts } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { probeMedia } from "@/lib/media-probe";
import { filterAssetsForScript, scriptRevision, shotKey, assetScopeForShot, assetMatchesScript } from "@/lib/asset-context";
import { extractFirstFrame, extractLastFrame } from "@/lib/video-composer/frame-extract";
import { MAX_DOWNLOAD_BYTES } from "@/lib/providers/stock-types";
import { klingJobOutputs, type KlingJob, type KlingJobOutput } from "./job-schema";
import { assertKlingJobLease, getKlingJob, getKlingOutputs, patchKlingJob, patchKlingOutput, refreshKlingImportState } from "./repository";
import { downloadPublicFile } from "./download";
import { KlingError } from "./errors";
import { cleanupDeletedKlingJob } from "./delete-job";

async function exists(file: string): Promise<boolean> {
  return stat(file).then((value) => value.isFile()).catch(() => false);
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function registerOutput(job: KlingJob, output: KlingJobOutput): void {
  getDb().transaction((tx) => {
    assertKlingJobLease(job.id);
    const current = tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.id, output.id)).get()!;
    if (current.assetId) {
      tx.update(klingJobOutputs).set({ importState: "imported", updatedAt: Date.now() }).where(eq(klingJobOutputs.id, output.id)).run();
      return;
    }
    if (!tx.select().from(projects).where(eq(projects.id, job.projectId)).get()) throw new KlingError("KLING_PROJECT_NOT_FOUND", "项目已不存在，视频仍保留在任务输出中", 409);
    const scriptRows = tx.select().from(scripts).where(eq(scripts.projectId, job.projectId)).all();
    const selectedScript = scriptRows.find((script) => script.selected) ?? scriptRows[0];
    const sourceScript = scriptRows.find((script) => script.id === job.scriptId);
    const shot = sourceScript?.shots?.find((item) => item.shotId === job.shotId);
    const scoped = selectedScript ? filterAssetsForScript(tx.select().from(assets).where(and(eq(assets.projectId, job.projectId), eq(assets.shotId, job.shotId), eq(assets.selected, true))).all(), selectedScript) : [];
    const baselineMatches = (scoped[0]?.id ?? null) === job.data.expectedSelectedAssetId;
    const contextMatches = Boolean(selectedScript && sourceScript && shot && selectedScript.id === job.scriptId &&
      scriptRevision(selectedScript) === job.data.scriptRevision && shotKey(sourceScript.id, shot) === job.data.shotKey);
    const alreadySelectedOutput = tx.select().from(klingJobOutputs).where(eq(klingJobOutputs.jobId, job.id)).all().some((item) => item.data.selectionOutcome === "selected");
    const selected = contextMatches && baselineMatches && !alreadySelectedOutput;
    const outcome = selected ? "selected" : contextMatches ? "kept_as_alternative" : "detached";
    if (selected && scoped.length) tx.update(assets).set({ selected: false }).where(inArray(assets.id, scoped.map((asset) => asset.id))).run();
    const id = randomUUID();
    tx.insert(assets).values({
      id, projectId: job.projectId, shotId: job.shotId, type: "ai_generated",
      filePath: current.data.filePath, thumbnailPath: current.data.thumbnailUrl ?? current.data.sourceKeyframeUrl,
      sourceKeyframeUrl: current.data.sourceKeyframeUrl,
      sourceScriptId: job.scriptId, sourceRevision: job.data.scriptRevision, sourceShotKey: job.data.shotKey,
      provider: "kling-cli", model: job.data.model.remoteModelId, prompt: job.data.prompt,
      selected, status: "done",
    }).run();
    tx.update(klingJobOutputs).set({
      assetId: id, importState: "imported", data: { ...current.data, selectionOutcome: outcome, error: undefined }, updatedAt: Date.now(),
    }).where(eq(klingJobOutputs.id, output.id)).run();
  });
}

async function importOutput(job: KlingJob, output: KlingJobOutput): Promise<void> {
  if (output.importState === "imported" && output.assetId) return;
  const directory = join(getUploadsDir(), job.projectId, "kling", job.id);
  await mkdir(directory, { recursive: true });
  assertKlingJobLease(job.id);
  const stem = join(directory, output.id);
  let final = output.data.localPath && !output.data.localPath.endsWith(".part") && await exists(output.data.localPath) ? output.data.localPath :
    await exists(stem + ".mp4") ? stem + ".mp4" : await exists(stem + ".webm") ? stem + ".webm" : undefined;
  const part = stem + ".part";
  if (!final) {
    patchKlingOutput(output.id, { importState: "downloading" }, { localPath: part, error: undefined });
    await unlink(part).catch(() => {});
    assertKlingJobLease(job.id);
    await downloadPublicFile(output.data.url, part, MAX_DOWNLOAD_BYTES);
  }
  patchKlingOutput(output.id, { importState: "validating" });
  const metadata = await probeMedia(final ?? part).catch((error: NodeJS.ErrnoException) => {
    throw new KlingError(error.code === "ENOENT" ? "KLING_MEDIA_TOOL_UNAVAILABLE" : "KLING_MEDIA_INVALID",
      error.code === "ENOENT" ? "FFprobe 不可用；视频已下载，可配置媒体工具后重新保存" : "下载内容不能解析为有效视频，请查询原任务并恢复保存", 502);
  });
  assertKlingJobLease(job.id);
  if (!metadata.width || !metadata.height || metadata.duration <= 0) throw new KlingError("KLING_MEDIA_INVALID", "下载内容不是具有有效尺寸和时长的视频", 502);
  if (!final) {
    const extension = metadata.formatName?.includes("webm") || metadata.formatName?.includes("matroska") ? ".webm" : ".mp4";
    final = stem + extension;
    await rename(part, final);
    assertKlingJobLease(job.id);
  }
  const filePath = "/api/files/" + [job.projectId, "kling", job.id, output.id + extname(final)].join("/");
  const contentHash = await hashFile(final);
  assertKlingJobLease(job.id);
  let sourceKeyframeUrl = output.data.sourceKeyframeUrl;
  if (!sourceKeyframeUrl && job.data.inputs[0]) {
    const input = job.data.inputs[0];
    const name = "source-keyframe" + extname(input.path);
    await copyFile(input.path, join(directory, name));
    assertKlingJobLease(job.id);
    sourceKeyframeUrl = "/api/files/" + [job.projectId, "kling", job.id, name].join("/");
  }
  const poster = await extractFirstFrame(final);
  assertKlingJobLease(job.id);
  await extractLastFrame(final);
  assertKlingJobLease(job.id);
  const thumbnailUrl = poster ? filePath + ".thumb.jpg" : sourceKeyframeUrl;
  output = patchKlingOutput(output.id, {}, {
    localPath: final, filePath, contentHash, byteSize: (await stat(final)).size,
    durationMs: Math.round(metadata.duration * 1000), width: metadata.width, height: metadata.height,
    hasAudio: metadata.hasAudio, sourceKeyframeUrl, thumbnailUrl, error: undefined,
  });
  registerOutput(job, output);
}

/** Caller holds the job lease; no new generation command can be reached here. */
export async function importKlingOutputs(jobId: string): Promise<void> {
  const job = getKlingJob(jobId);
  if (job.remoteState !== "completed") throw new KlingError("KLING_RESULTS_NOT_READY", "原任务尚未完成，不能保存视频", 409);
  const outputs = getKlingOutputs(jobId);
  if (!outputs.length) throw new KlingError("KLING_RESULTS_NOT_READY", "原任务完成但尚未返回视频作品，请继续查询", 409);
  try {
    patchKlingJob(jobId, { importState: "importing" });
    for (const output of outputs) {
      try { await importOutput(job, output); }
      catch (error) {
        assertKlingJobLease(jobId);
        const failure = error instanceof KlingError ? error : new KlingError("KLING_DOWNLOAD_FAILED", "生成已完成，本地保存失败。请恢复原任务的保存", 502);
        const detail = { code: failure.code, message: failure.message, retryable: true };
        patchKlingOutput(output.id, { importState: "failed" }, { error: detail });
        patchKlingJob(jobId, {}, { error: detail });
      }
    }
    refreshKlingImportState(jobId);
    const current = getKlingJob(jobId);
    if (current.importState === "completed") patchKlingJob(jobId, { nextQueryAt: null }, { error: undefined, blockedReason: undefined });
  } finally { cleanupDeletedKlingJob(jobId); }
}

/** Explicitly selecting a recovered take may create a derived local binding, never a generation. */
export function selectKlingOutput(jobId: string, outputId: string, adoptCurrentContext: boolean): void {
  const job = getKlingJob(jobId);
  getDb().transaction((tx) => {
    assertKlingJobLease(job.id);
    const output = tx.select().from(klingJobOutputs).where(and(eq(klingJobOutputs.id, outputId), eq(klingJobOutputs.jobId, jobId))).get();
    const original = output?.assetId ? tx.select().from(assets).where(eq(assets.id, output.assetId)).get() : null;
    if (!original || output?.importState !== "imported") throw new KlingError("KLING_OUTPUT_NOT_READY", "视频尚未入库", 409);
    const rows = tx.select().from(scripts).where(eq(scripts.projectId, job.projectId)).all();
    const script = rows.find((item) => item.selected) ?? rows[0];
    const shot = script?.shots?.find((item) => item.shotId === job.shotId);
    if (!script || !shot) throw new KlingError("KLING_CONTEXT_CHANGED", "当前脚本已没有对应镜头", 409);
    const matches = assetMatchesScript(original, script);
    if (!matches && !adoptCurrentContext) throw new KlingError("KLING_CONTEXT_CHANGED", "此视频属于旧脚本，请明确确认用于当前镜头", 409);
    const current = filterAssetsForScript(tx.select().from(assets).where(and(eq(assets.projectId, job.projectId), eq(assets.shotId, job.shotId), eq(assets.selected, true))).all(), script);
    if (current.length) tx.update(assets).set({ selected: false }).where(inArray(assets.id, current.map((item) => item.id))).run();
    if (matches) tx.update(assets).set({ selected: true }).where(eq(assets.id, original.id)).run();
    else {
      const derived = tx.select().from(assets).where(and(eq(assets.derivedFromAssetId, original.id), eq(assets.sourceScriptId, script.id), eq(assets.sourceRevision, scriptRevision(script)), eq(assets.sourceShotKey, shotKey(script.id, shot)))).get();
      if (derived) tx.update(assets).set({ selected: true }).where(eq(assets.id, derived.id)).run();
      else tx.insert(assets).values({
        projectId: job.projectId, shotId: job.shotId, type: "ai_generated", filePath: original.filePath,
        thumbnailPath: original.thumbnailPath, sourceKeyframeUrl: original.sourceKeyframeUrl,
        provider: "kling-cli", model: original.model, prompt: original.prompt,
        ...assetScopeForShot(script, shot, original.id), selected: true, status: "done",
      }).run();
    }
    tx.update(klingJobOutputs).set({ data: { ...output.data, selectionOutcome: "selected" }, updatedAt: Date.now() }).where(eq(klingJobOutputs.id, outputId)).run();
  });
}
