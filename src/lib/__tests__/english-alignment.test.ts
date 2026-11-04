// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocked.execFile }));

import { alignEnglishAudio, ENGLISH_ALIGNMENT_MODEL, type EnglishAlignmentInput, type EnglishAlignmentResult } from "@/lib/english-alignment";

type RequestJob = EnglishAlignmentInput & { audioPath: string };
type Request = { schemaVersion: number; ffmpegPath: string; jobs: RequestJob[] };
type ExecOptions = { shell?: unknown; windowsHide?: boolean; env?: Record<string, string> };
type Callback = (error: Error | null, stdout?: string, stderr?: string) => void;

function successfulResult(request: Request): EnglishAlignmentResult {
  return {
    schemaVersion: 1, model: ENGLISH_ALIGNMENT_MODEL, device: "cpu", asrUsed: false,
    jobs: request.jobs.map(job => ({
      id: job.id, durationSec: Math.min(job.maxDurationSec, 2),
      words: job.text.split(" ").map((text, index) => ({ text, startSec: index * 0.2 + 0.1, endSec: index * 0.2 + 0.25, score: 0.9 })),
    })),
  };
}

describe("English acoustic alignment process and cache", () => {
  let directory: string;
  let resource: string;
  let runtime: string;
  let data: string;
  let input: EnglishAlignmentInput;
  let requests: Request[];
  let resultTransform: (result: EnglishAlignmentResult) => unknown;
  let processError: (Error & { stderr?: string; killed?: boolean }) | undefined;
  let beforeProcess: (() => Promise<void>) | undefined;

  async function resourceFile(relative: string, contents = "fixture") {
    const filename = join(resource, relative);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, contents);
    return filename;
  }

  async function align(next: EnglishAlignmentInput = input, workName = "work") {
    return alignEnglishAudio([next], { workDir: join(directory, workName) });
  }

  beforeEach(async () => {
    mocked.execFile.mockReset();
    directory = await mkdtemp(join(tmpdir(), "clipforge-alignment-service-"));
    resource = join(directory, "app with spaces");
    runtime = join(directory, "runtime with spaces");
    data = join(directory, "data");
    vi.stubEnv("APP_RESOURCE_DIR", resource);
    vi.stubEnv("APP_ALIGNMENT_RUNTIME_DIR", runtime);
    vi.stubEnv("APP_DATA_DIR", data);
    const python = join(runtime, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    for (const filename of [python, join(runtime, "model", "model.safetensors")]) {
      await mkdir(dirname(filename), { recursive: true });
      await writeFile(filename, "fixture");
    }
    await writeFile(join(runtime, "ready.json"), JSON.stringify({
      schemaVersion: 1, runtimeVersion: "english-alignment-v1", model: ENGLISH_ALIGNMENT_MODEL,
      modelRevision: "22aad52d435eb6dbaf354bdad9b0da84ce7d6156", device: "cpu", asrUsed: false,
    }));
    await resourceFile("scripts/alignment/align.py");
    input = { id: "shot-1", text: "Stay dry.", sourcePath: await resourceFile("speech one.mp4", "original-media-bytes"), maxDurationSec: 3 };
    requests = [];
    resultTransform = result => result;
    processError = undefined;
    beforeProcess = undefined;
    mocked.execFile.mockImplementation((_file: string, args: string[], _options: ExecOptions, callback: Callback) => {
      void (async () => {
        try {
          if (beforeProcess) await beforeProcess();
          if (processError) throw processError;
          const requestPath = args[args.indexOf("--input") + 1];
          const resultPath = args[args.indexOf("--output") + 1];
          const request = JSON.parse(await readFile(requestPath, "utf8")) as Request;
          requests.push(request);
          await writeFile(resultPath, JSON.stringify(resultTransform(successfulResult(request))));
          callback(null, "", "");
        } catch (error) { callback(error as Error); }
      })();
      return {};
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reuses identical media bytes even under another filename and assigns the requested shot id", async () => {
    const first = await align();
    const identical = await resourceFile("a differently named video.mov", "original-media-bytes");
    const second = await align({ ...input, id: "shot-2", sourcePath: identical });
    expect(mocked.execFile).toHaveBeenCalledTimes(1);
    expect(second.jobs[0]).toEqual({ ...first.jobs[0], id: "shot-2" });
    expect(await readdir(join(data, "cache", "english-alignment"))).toHaveLength(1);
  });

  it("invalidates acoustic results when media bytes, narration text or played duration changes", async () => {
    await align();
    await writeFile(input.sourcePath, "regenerated-video-new-audio");
    await align();
    await align({ ...input, text: "Keep dry." });
    await align({ ...input, text: "Keep dry.", maxDurationSec: 2.5 });
    expect(mocked.execFile).toHaveBeenCalledTimes(4);
    expect(await readdir(join(data, "cache", "english-alignment"))).toHaveLength(4);
    expect(requests.map(request => [request.jobs[0].text, request.jobs[0].maxDurationSec])).toEqual([
      ["Stay dry.", 3], ["Stay dry.", 3], ["Keep dry.", 3], ["Keep dry.", 2.5],
    ]);
  });

  it("recomputes corrupted cache entries instead of treating them as timestamps", async () => {
    await align();
    const cacheDir = join(data, "cache", "english-alignment");
    const [name] = await readdir(cacheDir);
    const cached = JSON.parse(await readFile(join(cacheDir, name), "utf8"));
    cached.job.words[1].endSec = -3;
    await writeFile(join(cacheDir, name), JSON.stringify(cached));
    const recovered = await align();
    expect(mocked.execFile).toHaveBeenCalledTimes(2);
    expect(recovered.jobs[0].words[1].endSec).toBeGreaterThan(0);
  });

  it("passes the exact selected audio/video source via JSON and launches without a command shell", async () => {
    const sourcePath = await resourceFile("voice $(ignored) & quote's.mp3", "tts-track-bytes");
    await align({ ...input, sourcePath, text: "Stay   dry." });
    const [file, args, options] = mocked.execFile.mock.calls[0] as [string, string[], ExecOptions];
    expect(file).toBe(join(runtime, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"));
    expect(args[0]).toBe(join(resource, "scripts", "alignment", "align.py"));
    expect(args).toContain(runtime);
    expect(args).not.toContain(sourcePath);
    expect(options.shell).toBeUndefined();
    expect(options.windowsHide).toBe(true);
    expect(options.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONIOENCODING: "utf-8" });
    expect(requests[0].jobs[0]).toMatchObject({ sourcePath, text: "Stay dry.", maxDurationSec: 3 });
    expect(requests[0].ffmpegPath).toBeTruthy();
  });

  it("reports a missing runtime with an actionable start.cmd instruction without spawning anything", async () => {
    await rm(join(runtime, "ready.json"));
    await expect(align()).rejects.toThrow(/start\.cmd/);
    expect(mocked.execFile).not.toHaveBeenCalled();
  });

  it("rejects an incompatible ready marker even when Python and weights exist", async () => {
    await writeFile(join(runtime, "ready.json"), JSON.stringify({
      schemaVersion: 1, runtimeVersion: "old-runtime", model: ENGLISH_ALIGNMENT_MODEL,
      device: "cpu", asrUsed: false,
    }));
    await expect(align()).rejects.toThrow(/start\.cmd/);
    expect(mocked.execFile).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong model", (result: EnglishAlignmentResult) => ({ ...result, model: "a-transcription-model" })],
    ["ASR instead of alignment", (result: EnglishAlignmentResult) => ({ ...result, asrUsed: true })],
    ["no returned shot", (result: EnglishAlignmentResult) => ({ ...result, jobs: [] })],
    ["missing word", (result: EnglishAlignmentResult) => { result.jobs[0].words.pop(); return result; }],
    ["changed narration", (result: EnglishAlignmentResult) => { result.jobs[0].words[0].text = "Changed"; return result; }],
    ["negative start", (result: EnglishAlignmentResult) => { result.jobs[0].words[0].startSec = -1; return result; }],
    ["zero word length", (result: EnglishAlignmentResult) => { result.jobs[0].words[0].endSec = 0.1; return result; }],
    ["invalid number", (result: EnglishAlignmentResult) => { result.jobs[0].words[0].endSec = NaN; return result; }],
    ["word past audio end", (result: EnglishAlignmentResult) => { result.jobs[0].words[0].endSec = 2.5; return result; }],
    ["nonmonotonic starts", (result: EnglishAlignmentResult) => { result.jobs[0].words[1].startSec = 0; return result; }],
    ["audio longer than played clip", (result: EnglishAlignmentResult) => { result.jobs[0].durationSec = 5; return result; }],
  ])("rejects %s and does not cache fabricated or incomplete results", async (_label, transform) => {
    resultTransform = transform;
    await expect(align()).rejects.toThrow();
    expect(await readdir(join(data, "cache", "english-alignment"))).toHaveLength(0);
  });

  it("reports worker errors and releases the CPU queue so the next request can recover", async () => {
    processError = Object.assign(new Error("worker exited"), { stderr: "No acoustic path for dry." });
    await expect(align()).rejects.toThrow(/No acoustic path for dry/);
    processError = undefined;
    const next = await align();
    expect(next.jobs[0].words).toHaveLength(2);
    expect(mocked.execFile).toHaveBeenCalledTimes(2);
  });

  it("turns a killed alignment process into a useful timeout error", async () => {
    processError = Object.assign(new Error("killed"), { killed: true });
    await expect(align()).rejects.toThrow(/超时/);
    expect(await readdir(join(data, "cache", "english-alignment"))).toHaveLength(0);
  });

  it("serializes concurrent jobs and allows the second caller to reuse the first result", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    beforeProcess = async () => { entered(); await gate; };
    const first = align(input, "first");
    const second = align({ ...input, id: "shot-second" }, "second");
    await started;
    expect(mocked.execFile).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(mocked.execFile).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.jobs[0].id)).toEqual(["shot-1", "shot-second"]);
  });

  it("rejects duplicate ids and non-English copy before requesting a model process", async () => {
    await expect(alignEnglishAudio([input, input], { workDir: join(directory, "bad") })).rejects.toThrow();
    await expect(align({ ...input, text: "这是中文" })).rejects.toThrow(/英文/);
    expect(mocked.execFile).not.toHaveBeenCalled();
  });

  it("returns an empty result without requiring a runtime when no spoken lines exist", async () => {
    await rm(runtime, { recursive: true, force: true });
    const result = await alignEnglishAudio([], { workDir: join(directory, "empty") });
    expect(result).toEqual({ schemaVersion: 1, model: ENGLISH_ALIGNMENT_MODEL, device: "cpu", asrUsed: false, jobs: [] });
    expect(mocked.execFile).not.toHaveBeenCalled();
  });
});
