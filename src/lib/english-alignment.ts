import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { promisify } from "node:util";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { getAppResourceDir, getDataDir } from "@/lib/paths";
import { isManagedDesktopRuntime } from "@/lib/runtime-capabilities";

const run = promisify(execFile);
export const ENGLISH_ALIGNMENT_MODEL = "facebook/wav2vec2-base-960h";
const CACHE_VERSION = "whisperx-3.8.6-wav2vec2-22aad52d-v1";

export interface EnglishAlignmentInput {
  id: string;
  text: string;
  /** The narration file actually used by the composer, otherwise its native video. */
  sourcePath: string;
  maxDurationSec: number;
}
export interface EnglishAlignedJob {
  id: string;
  durationSec: number;
  words: { text: string; startSec: number; endSec: number; score?: number }[];
}
export interface EnglishAlignmentResult {
  schemaVersion: 1;
  model: typeof ENGLISH_ALIGNMENT_MODEL;
  device: "cpu";
  asrUsed: false;
  jobs: EnglishAlignedJob[];
}

export function englishAlignmentRuntimeDir(): string {
  return process.env.APP_ALIGNMENT_RUNTIME_DIR || join(getAppResourceDir(), ".clipforge", "tools", "english-align");
}

function validateJob(result: EnglishAlignedJob, input: EnglishAlignmentInput): void {
  const tokens = input.text.trim().split(/\s+/);
  if (result.id !== input.id || !Number.isFinite(result.durationSec) || result.durationSec <= 0
    || result.durationSec > input.maxDurationSec + 0.02 || !Array.isArray(result.words)
    || result.words.length !== tokens.length) throw new Error(`镜头 ${input.id} 音频对齐结果不完整`);
  result.words.forEach((word, index) => {
    if (word.text !== tokens[index] || !Number.isFinite(word.startSec) || !Number.isFinite(word.endSec)
      || word.startSec < 0 || word.endSec <= word.startSec || word.endSec > result.durationSec + 0.02
      || (index > 0 && word.startSec < result.words[index - 1].startSec)) {
      throw new Error(`镜头 ${input.id} 的 ${tokens[index]} 缺少有效的真实词时间戳`);
    }
  });
}

async function cacheKey(input: EnglishAlignmentInput): Promise<string> {
  const hash = createHash("sha256").update(`${CACHE_VERSION}\0${input.text}\0${input.maxDurationSec}\0`);
  for await (const chunk of createReadStream(input.sourcePath)) hash.update(chunk);
  return hash.digest("hex");
}

// One CPU model at a time, also across Next development module reloads.
const shared = globalThis as typeof globalThis & { clipforgeAlignmentQueue?: Promise<void> };
async function serial<T>(task: () => Promise<T>): Promise<T> {
  const previous = shared.clipforgeAlignmentQueue || Promise.resolve();
  let release!: () => void;
  shared.clipforgeAlignmentQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}

/** Reuses acoustic results only when the exact media bytes, copy and played duration match. */
export async function alignEnglishAudio(
  inputs: readonly EnglishAlignmentInput[], options: { workDir: string },
): Promise<EnglishAlignmentResult> {
  if (!inputs.length) return { schemaVersion: 1, model: ENGLISH_ALIGNMENT_MODEL, device: "cpu", asrUsed: false, jobs: [] };
  const ids = new Set<string>();
  for (const input of inputs) {
    if (!input.id || ids.has(input.id) || !input.text.trim() || !Number.isFinite(input.maxDurationSec) || input.maxDurationSec <= 0) {
      throw new Error("英文音频对齐参数无效");
    }
    ids.add(input.id);
    if (/[^\x00-\x7f]/.test(input.text.replace(/[’‘“”–—…]/g, ""))) {
      throw new Error(`镜头 ${input.id} 的字幕目前仅支持英文音频对齐，请使用英文口播文案或关闭字幕`);
    }
  }
  return serial(async () => {
    const managed = isManagedDesktopRuntime();
    // CPython preserves this prefix in sys.prefix/site-packages. Without it,
    // metadata and Transformers imports can fail under long Windows install paths.
    const executionPath = (value: string) => managed && process.platform === "win32" ? toNamespacedPath(value) : value;
    const runtime = englishAlignmentRuntimeDir();
    const python = process.env.APP_ALIGNMENT_PYTHON || join(runtime, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const modelDirectory = process.env.APP_ALIGNMENT_MODEL_DIR || join(runtime, "model");
    const runner = join(getAppResourceDir(), "scripts", "alignment", "align.py");
    let ready: { schemaVersion?: number; runtimeVersion?: string; model?: string; modelRevision?: string; asrUsed?: boolean; device?: string } | undefined;
    try { ready = JSON.parse(await readFile(join(runtime, "ready.json"), "utf8")); } catch { /* launcher repairs incomplete installations */ }
    if (![python, runner, join(modelDirectory, "model.safetensors")].every(existsSync)
      || ready?.schemaVersion !== 1 || ready.runtimeVersion !== "english-alignment-v1"
      || ready.model !== ENGLISH_ALIGNMENT_MODEL || ready.modelRevision !== "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"
      || ready.device !== "cpu" || ready.asrUsed !== false) {
      throw new Error(process.env.CLIPFORGE_RUNTIME === "desktop"
        ? "英文音频对齐资源未就绪，请退出客户端并运行安装程序修复资源，再重新合成"
        : "英文音频对齐环境未就绪，请关闭项目后双击 start.cmd 完成自动初始化，再重新合成");
    }
    const cacheDir = join(getDataDir(), "cache", "english-alignment");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(options.workDir, { recursive: true });
    const jobs: EnglishAlignedJob[] = [];
    const pending: { input: EnglishAlignmentInput; key: string }[] = [];
    for (const input of inputs) {
      const key = await cacheKey(input);
      try {
        const cached = JSON.parse(await readFile(join(cacheDir, `${key}.json`), "utf8"));
        const job = { ...cached.job, id: input.id } as EnglishAlignedJob;
        if (cached.version !== CACHE_VERSION) throw new Error("Outdated alignment cache");
        validateJob(job, input);
        jobs.push(job);
      } catch { pending.push({ input, key }); }
    }
    if (pending.length) {
      const inputPath = join(options.workDir, "request.json");
      const outputPath = join(options.workDir, "result.json");
      await writeFile(inputPath, JSON.stringify({ schemaVersion: 1, ffmpegPath: ffmpegBin(),
        jobs: pending.map(({ input }, index) => ({ ...input, text: input.text.trim().replace(/\s+/g, " "),
          audioPath: join(options.workDir, `audio-${index}.wav`) })) }));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, APP_ALIGNMENT_MODEL_DIR: executionPath(modelDirectory), PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" };
        if (managed) {
          for (const key of Object.keys(env)) if (/^(?:PYTHONHOME|PYTHONPATH|PYTHONUSERBASE)$/i.test(key)) delete env[key];
        }
        await run(executionPath(python), [executionPath(runner), "--runtime-dir", executionPath(runtime), "--input", executionPath(inputPath), "--output", executionPath(outputPath)], {
          windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
          env,
        });
      } catch (error) {
        const detail = error as Error & { stderr?: string; killed?: boolean };
        throw new Error(detail.killed ? "英文音频对齐超时，请重试或缩短镜头" :
          `英文音频对齐失败：${(detail.stderr || detail.message).trim().slice(-2000)}`);
      }
      const result = JSON.parse(await readFile(outputPath, "utf8")) as EnglishAlignmentResult;
      if (result.schemaVersion !== 1 || result.model !== ENGLISH_ALIGNMENT_MODEL || result.asrUsed !== false
        || result.device !== "cpu" || !Array.isArray(result.jobs) || result.jobs.length !== pending.length) {
        throw new Error("英文音频对齐结果格式无效，未生成估算字幕");
      }
      for (const { input, key } of pending) {
        const job = result.jobs.find(job => job.id === input.id);
        if (!job) throw new Error(`镜头 ${input.id} 未返回音频对齐结果`);
        validateJob(job, input);
        jobs.push(job);
        const target = join(cacheDir, `${key}.json`);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, model: ENGLISH_ALIGNMENT_MODEL, job }));
        await rename(temporary, target);
      }
    }
    return { schemaVersion: 1, model: ENGLISH_ALIGNMENT_MODEL, device: "cpu", asrUsed: false,
      jobs: inputs.map(input => jobs.find(job => job.id === input.id)!) };
  });
}
