// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKlingVideoArguments, canonicalJson, contentHash, normalizeVideoParameters, prepareKlingInputs } from "@/lib/kling/inputs";
import { klingModelOptions } from "@/lib/kling/model-options";
import { parseCatalog } from "@/lib/kling/protocol";
import * as ffmpegPath from "@/lib/ffmpeg-path";
import type { KlingVideoModelDescriptor } from "@/lib/kling/types";

const fixture = vi.hoisted(() => ({ directory: "", uploads: "", probe: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => fixture.directory, getUploadsDir: () => fixture.uploads }));
vi.mock("@/lib/media-probe", () => ({ probeMedia: fixture.probe }));
vi.mock("@/lib/kling/download", () => ({ downloadPublicFile: fixture.download }));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const jpg = Buffer.from([255, 216, 255, 1, 2, 3]);
// A real 4x4 WebP: conversion tests use the installed FFmpeg/FFprobe, with no cloud calls.
const webp = Buffer.from("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoEAAQAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=", "base64");
function descriptor(): KlingVideoModelDescriptor {
  return { selectionKey: '["kling-cli","image_to_video","remote"]', provider: "kling-cli", profileId: "profile", region: "global", tool: "image_to_video", remoteModelId: "remote", displayName: "Remote", catalogRevision: "rev", available: true,
    parameters: [{ name: "duration", required: true, type: "number", allowedValues: [5, 10], default: 5 }, { name: "aspect_ratio", required: false, type: "string", allowedValues: ["9:16", "16:9"] }, { name: "sound", required: false, type: "boolean", default: false }],
    inputSlots: [{ name: "image", required: true, role: "image" }, { name: "tailImage", required: false, role: "tailImage" }], capabilities: { image: true, tailFrame: true, multiImage: false, audio: true } };
}
beforeAll(async () => {
  fixture.directory = await mkdtemp(join(tmpdir(), "clipforge-kling-inputs-")); fixture.uploads = join(fixture.directory, "uploads");
  await mkdir(fixture.uploads); await writeFile(join(fixture.uploads, "product.png"), png); await writeFile(join(fixture.uploads, "tail.jpg"), jpg); await writeFile(join(fixture.directory, "outside.png"), png);
});
afterAll(async () => { await rm(fixture.directory, { recursive: true, force: true }); });
beforeEach(() => { fixture.probe.mockReset().mockResolvedValue({ width: 100, height: 200 }); fixture.download.mockReset(); });

describe("Kling submission preflight", () => {
  it("hashes canonical object keys while retaining meaningful reference array order", () => {
    expect(canonicalJson({ z: 1, a: [1, 2], omitted: undefined })).toBe('{"a":[1,2],"z":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash(["product", "tail"])).not.toBe(contentHash(["tail", "product"]));
  });
  it("maps declared CLI aliases and defaults without treating enum metadata as a capability restriction", () => {
    expect(normalizeVideoParameters(descriptor(), { duration: "10", aspectRatio: "9:16", audioEnabled: true })).toEqual({ duration: 10, aspect_ratio: "9:16", sound: true });
    expect(normalizeVideoParameters(descriptor(), {})).toEqual({ duration: 5 });
    expect(normalizeVideoParameters(descriptor(), { duration: 6 }).duration).toBe(6);
    expect(() => normalizeVideoParameters(descriptor(), { sound: "true" })).toThrow();
    expect(() => normalizeVideoParameters(descriptor(), { unsupported: 1 })).toThrow();
    expect(() => normalizeVideoParameters(descriptor(), { duration: Infinity })).toThrow();
  });
  it("uses declared duration tiers where possible and otherwise lets the provider evaluate requested duration", () => {
    expect(normalizeVideoParameters(descriptor(), { duration: 5 }, 5.4).duration).toBe(10);
    expect(normalizeVideoParameters(descriptor(), {}, 5.4).duration).toBe(10);
    expect(normalizeVideoParameters(descriptor(), { duration: 5 }).duration).toBe(5);
    expect(normalizeVideoParameters(descriptor(), {}, 10.1).duration).toBe(11);
    expect(normalizeVideoParameters({ ...descriptor(), parameters: [] }, {}, 5)).toEqual({});
  });
  it("keeps requested scalar settings and silence controls independent of stale catalog choices", () => {
    const model = descriptor();
    model.parameters.push({ name: "resolution", type: "string", required: false, allowedValues: ["720p"] });
    const mapped = klingModelOptions(model, { duration: 30, aspectRatio: "1:1", resolution: "1080p", audioEnabled: true });
    expect(mapped).toEqual({ options: { duration: 30, sound: true, aspect_ratio: "1:1", resolution: "1080p" }, warnings: [], unsupportedSettings: [] });
    expect(normalizeVideoParameters(model, mapped.options)).toEqual(mapped.options);
    const defaults = { ...model, parameters: [{ name: "sound", type: "string" as const, required: true, allowedValues: ["off"], default: "off" }] };
    expect(klingModelOptions(defaults, { audioEnabled: true }).options).toEqual({});
    expect(normalizeVideoParameters(defaults, {})).toEqual({});
    expect(normalizeVideoParameters(defaults, { sound: "off" })).toEqual({ sound: "off" });
    expect(buildKlingVideoArguments(defaults, "A presenter speaks in English", {}, [], "default-native")).not.toContain("--sound");
    expect(klingModelOptions(model, { duration: 7 }).options.duration).toBe(7);
  });
  it.each([false, true])("replays the same ordered CLI options after minimum-duration adjustment and inserted defaults with sound=%s", (sound) => {
    const model = descriptor();
    model.parameters.push({ name: "quality", type: "string", required: false, default: "pro" });
    const prepared = normalizeVideoParameters(model, { sound }, 12.1);
    const replayed = normalizeVideoParameters(model, prepared, 12.1);
    expect(Object.keys(prepared)).toEqual(["duration", "sound", "quality"]);
    expect(Object.entries(replayed)).toEqual(Object.entries(prepared));
    expect(buildKlingVideoArguments(model, "A presenter speaks", prepared, [], "replayed")).toEqual(buildKlingVideoArguments(model, "A presenter speaks", replayed, [], "replayed"));
    expect(prepared.duration).toBe(13);
  });
  it("leaves absent CLI settings and required defaults to the provider without inventing flags", () => {
    const model = { ...descriptor(), parameters: [{ name: "future_option", type: "string" as const, required: true }] };
    expect(normalizeVideoParameters(model, { duration: 8, audioEnabled: true, aspectRatio: "9:16" }, 8)).toEqual({});
    expect(normalizeVideoParameters(model, { future_option: "requested-value" })).toEqual({ future_option: "requested-value" });
    expect(klingModelOptions(model, { duration: 8, resolution: "4k", audioEnabled: true })).toEqual({ options: {}, warnings: [], unsupportedSettings: [] });
  });
  it("selects one usable audio switch without injecting contradictory defaults from other aliases", () => {
    const model = { ...descriptor(), parameters: [
      { name: "audio", type: "boolean" as const, required: false, allowedValues: [false], default: false },
      { name: "sound", type: "string" as const, required: false, allowedValues: ["off", "on"], default: "off" },
      { name: "enable_audio", type: "boolean" as const, required: false, default: false },
      { name: "duration", type: "number" as const, required: false, default: 5 },
    ] };
    const mapped = klingModelOptions(model, { audioEnabled: true });
    expect(mapped.options).toEqual({ duration: 5, sound: "on" });
    expect(klingModelOptions(model, {}).options).toEqual({ duration: 5 });
    expect(normalizeVideoParameters(model, {})).toEqual({ duration: 5 });
    const prepared = normalizeVideoParameters(model, mapped.options, 7);
    expect(Object.entries(normalizeVideoParameters(model, prepared, 7))).toEqual(Object.entries(prepared));
    const args = buildKlingVideoArguments(model, "A presenter speaks in English", prepared, [], "one-audio-switch");
    expect(args.slice(args.indexOf("--sound"), args.indexOf("--sound") + 2)).toEqual(["--sound", "on"]);
    expect(args).not.toContain("--audio");
    expect(args).not.toContain("--enable_audio");
    expect(normalizeVideoParameters(model, { audio: false })).toEqual({ audio: false, duration: 5 });
    expect(klingModelOptions(model, { audioEnabled: false }).options).toEqual({ duration: 5, audio: false });
  });
  it.each([false, true])("preserves the official Kling 3 enable_audio=%s setting from discovery through CLI submission", async (audioEnabled) => {
    // Relevant image_to_video model fields returned by live who_am_i on 2026-10-20.
    const [model] = parseCatalog({ ok: true, body: { availableModels: { image_to_video: [{
      model: "kling-video-v3_0",
      arguments: [
        { name: "prompt", required: true },
        { name: "duration", required: false, default: "5", allowedValues: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"] },
        { name: "resolution", required: false, default: "1080p", allowedValues: ["720p", "1080p", "4k"] },
        { name: "imageCount", required: false, default: "1", allowedValues: ["1", "2", "3", "4"] },
        { name: "prefer_multi_shots", required: false, default: "true", allowedValues: ["true", "false"] },
        { name: "enable_audio", required: false, default: "true", allowedValues: ["true", "false"], description: "Whether to enable audio-video sync. When 'true', the model directly produces a work that includes audio." },
        { name: "elements", required: false, maxItems: 3 },
      ],
      inputs: [{ name: "first_image", required: true }, { name: "tail_image", required: false }],
    }] } } }, "profile");
    expect(model.capabilities.audio).toBe(true);
    expect(model.parameters.find((parameter) => parameter.name === "enable_audio")).toMatchObject({ type: "string", default: "true", allowedValues: ["true", "false"] });
    const mapped = klingModelOptions(model, { audioEnabled });
    expect(mapped.warnings).toEqual([]);
    expect(mapped.unsupportedSettings).toEqual([]);
    expect(mapped.options.enable_audio).toBe(String(audioEnabled));
    const inputs = await prepareKlingInputs("native-audio-" + audioEnabled, model, [{ role: "image", sourceUrl: "/api/files/product.png" }]);
    const args = buildKlingVideoArguments(model, "A product on a table", mapped.options, inputs, "audio-job");
    expect(args.slice(args.indexOf("--enable_audio"), args.indexOf("--enable_audio") + 2)).toEqual(["--enable_audio", String(audioEnabled)]);
    expect(args.filter((argument) => argument === "--enable_audio")).toHaveLength(1);
  });
  it("recognizes Kling 4 native audio without inventing a switch omitted from its official parameter declaration", () => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: "kling-video-v4_0", arguments: [
      { name: "prompt", required: true },
      { name: "duration", default: "10", allowedValues: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30"] },
      { name: "resolution", default: "720p", allowedValues: ["720p", "1080p"] },
      { name: "imageCount", default: "1", allowedValues: ["1", "2", "3", "4"] },
      { name: "aspect_ratio", allowedValues: ["16:9", "9:16", "1:1", "21:9"] },
    ], inputs: [{ name: "first_image", required: false }, { name: "tail_image", required: false }] }] } }, "profile");
    expect(model.capabilities.audio).toBe(true);
    const mapped = klingModelOptions(model, { audioEnabled: false });
    expect(mapped.options).not.toHaveProperty("enable_audio");
    expect(buildKlingVideoArguments(model, "A silent product shot", { ...mapped.options, enable_audio: "false" }, [], "audio-job")).not.toContain("--enable_audio");
  });
  it("accepts scalar defaults outside stale enum metadata while rejecting reserved CLI flags", () => {
    const model = descriptor(); model.parameters[0].default = 99;
    expect(normalizeVideoParameters(model, {}).duration).toBe(99);
    model.parameters = [{ name: "poll", type: "boolean", required: false, default: true }];
    expect(() => normalizeVideoParameters(model, {})).toThrow();
  });
  it("validates command image fields without blocking reference counts or tools using catalog capability assumptions", async () => {
    await expect(prepareKlingInputs("no-image", descriptor(), [])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    await expect(prepareKlingInputs("tail-only", descriptor(), [{ role: "tailImage", sourceUrl: "/api/files/tail.jpg" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    const model = descriptor(); model.inputSlots.push({ name: "secondTail", role: "tailImage", required: false });
    await expect(prepareKlingInputs("duplicate-tail", model, [{ role: "image", sourceUrl: "/api/files/product.png" }, { role: "tailImage", sourceUrl: "/api/files/tail.jpg" }, { role: "tailImage", sourceUrl: "/api/files/tail.jpg" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    await expect(prepareKlingInputs("multi-image", descriptor(), [{ role: "image", sourceUrl: "/api/files/product.png" }, { role: "image", sourceUrl: "/api/files/product.png" }])).resolves.toHaveLength(2);
    await expect(prepareKlingInputs("text-image", { ...descriptor(), tool: "text_to_video" }, [{ role: "image", sourceUrl: "/api/files/product.png" }])).resolves.toHaveLength(1);
  });
  it("takes immutable input snapshots and keeps role/content order in CLI argument arrays", async () => {
    const images = await prepareKlingInputs("ordered", descriptor(), [{ role: "image", sourceUrl: "/api/files/product.png" }, { role: "tailImage", sourceUrl: "/api/files/tail.jpg" }]);
    expect(images.map((image) => image.role)).toEqual(["image", "tailImage"]);
    expect(images.map((image) => image.hash)).toEqual([contentHash(png), contentHash(jpg)]);
    expect(await readFile(images[0].path)).toEqual(png);
    expect(images[0].path).not.toBe(join(fixture.uploads, "product.png"));
    const prompt = "运镜：固定镜头。\n画面动态：商品展示。\n场景：中文商品镜头 & $() ` literal。\n\n声音要求：视频全程静音。";
    const args = buildKlingVideoArguments(descriptor(), prompt, { duration: 5, sound: false }, images, "job-1");
    expect(args.slice(0, 6)).toEqual(["image_to_video", "--model", "remote", "--quiet", "--task-trace-id", "job-1"]);
    expect(args.slice(6, 10)).toEqual(["--image", images[0].path, "--tailImage", images[1].path]);
    expect(args.at(-1)).toBe(prompt);
    expect(args).not.toContain("--poll");
  });
  it("submits first, extra reference and tail images even when cached capability metadata is false", async () => {
    const model = { ...descriptor(), inputSlots: [], capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } };
    const inputs = await prepareKlingInputs("optimistic-references", model, [
      { role: "image", sourceUrl: "/api/files/product.png" },
      { role: "image", sourceUrl: "/api/files/product.png" },
      { role: "tailImage", sourceUrl: "/api/files/tail.jpg" },
    ]);
    expect(inputs.map((input) => input.role)).toEqual(["image", "image", "tailImage"]);
    const args = buildKlingVideoArguments(model, "A product on a table", {}, inputs, "optimistic-references");
    expect(args.filter((arg) => arg === "--image")).toHaveLength(2);
    expect(args).toContain("--tailImage");
  });
  it("uses the CLI image command to forward selected references even with a text catalog descriptor", async () => {
    const model = { ...descriptor(), tool: "text_to_video" as const, inputSlots: [] };
    const inputs = await prepareKlingInputs("text-catalog-with-image", model, [{ role: "image", sourceUrl: "/api/files/product.png" }]);
    const args = buildKlingVideoArguments(model, "A product on a table", {}, inputs, "text-catalog-with-image");
    expect(args.slice(0, 3)).toEqual(["image_to_video", "--model", model.remoteModelId]);
    expect(args.slice(6, 8)).toEqual(["--image", inputs[0].path]);
    expect(buildKlingVideoArguments(model, "A product on a table", {}, [], "text-catalog-alone")[0]).toBe("text_to_video");
  });
  it("blocks path traversal and refuses unsupported file content before submission", async () => {
    await expect(prepareKlingInputs("traversal", descriptor(), [{ role: "image", sourceUrl: "/api/files/%2e%2e/outside.png" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    await expect(prepareKlingInputs("arbitrary-path", descriptor(), [{ role: "image", sourceUrl: "C:/private/photo.png" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    await expect(prepareKlingInputs("bad-data", descriptor(), [{ role: "image", sourceUrl: "data:image/png;base64,SGVsbG8=" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    expect(fixture.download).not.toHaveBeenCalled();
  });
  it("actually converts local WebP first/tail frames to PNG and hashes the uploaded bytes without altering source images", async () => {
    const { probeMedia } = await vi.importActual<typeof import("@/lib/media-probe")>("@/lib/media-probe");
    fixture.probe.mockImplementation(probeMedia);
    const sourcePath = join(fixture.uploads, "frame.webp");
    await writeFile(sourcePath, webp);
    const refs = [{ role: "image" as const, sourceUrl: "/api/files/frame.webp" }, { role: "tailImage" as const, sourceUrl: "/api/files/frame.webp" }];
    const inputs = await prepareKlingInputs("real-webp", descriptor(), refs);
    for (const [index, input] of inputs.entries()) {
      const converted = await readFile(input.path);
      expect(input.path).toBe(join(fixture.directory, "integrations", "kling", "jobs", "real-webp", "inputs", `${index}.png`));
      expect(converted.subarray(0, 8)).toEqual(png.subarray(0, 8));
      expect(input).toMatchObject({ ...refs[index], hash: contentHash(converted), sourceHash: contentHash(webp), size: converted.length });
      expect(input.hash).not.toBe(contentHash(webp));
      expect(await probeMedia(input.path)).toMatchObject({ width: 4, height: 4, videoCodec: "png" });
    }
    expect(await readFile(sourcePath)).toEqual(webp);
    const args = buildKlingVideoArguments(descriptor(), "A product on a table", {}, inputs, "real-webp");
    expect(args.slice(6, 10)).toEqual(["--image", inputs[0].path, "--tailImage", inputs[1].path]);
    expect(fixture.download).not.toHaveBeenCalled();
  });
  it("also converts data URI WebP based on file bytes", async () => {
    const { probeMedia } = await vi.importActual<typeof import("@/lib/media-probe")>("@/lib/media-probe");
    fixture.probe.mockImplementation(probeMedia);
    const sourceUrl = "data:image/png;base64," + webp.toString("base64");
    const [input] = await prepareKlingInputs("data-webp", descriptor(), [{ role: "image", sourceUrl }]);
    expect(input.path).toMatch(/0\.png$/);
    expect(input.sourceUrl).toBe(sourceUrl);
    expect(await probeMedia(input.path)).toMatchObject({ width: 4, height: 4, videoCodec: "png" });
    expect(fixture.download).not.toHaveBeenCalled();
  });
  it("refuses broken WebP rather than passing it through to the CLI", async () => {
    const broken = webp.subarray(0, 16);
    await expect(prepareKlingInputs("broken-webp", descriptor(), [{ role: "image", sourceUrl: "data:image/webp;base64," + broken.toString("base64") }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID", message: expect.stringContaining("无法转换") });
    await expect(readFile(join(fixture.directory, "integrations", "kling", "jobs", "broken-webp", "inputs", "0.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reports unavailable conversion tools without exposing command paths", async () => {
    const spy = vi.spyOn(ffmpegPath, "ffmpegBin").mockReturnValue(join(fixture.directory, "missing-ffmpeg.exe"));
    try {
      await expect(prepareKlingInputs("no-converter", descriptor(), [{ role: "image", sourceUrl: "data:image/webp;base64," + webp.toString("base64") }])).rejects.toMatchObject({ code: "KLING_MEDIA_TOOL_UNAVAILABLE", message: "未找到 FFmpeg 或 FFprobe，无法转换 WebP 图片，请先配置媒体工具" });
    } finally { spy.mockRestore(); }
  });
  it("rejects oversized decoded data images before media probing or CLI upload", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1); png.copy(bytes);
    await expect(prepareKlingInputs("large-data", descriptor(), [{ role: "image", sourceUrl: "data:image/png;base64," + bytes.toString("base64") }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID" });
    expect(fixture.probe).not.toHaveBeenCalled();
  });
  it("reports a missing uploaded image as an actionable input error", async () => {
    await expect(prepareKlingInputs("missing-local", descriptor(), [{ role: "image", sourceUrl: "/api/files/deleted.png" }])).rejects.toMatchObject({ code: "KLING_INPUT_INVALID", status: 422 });
  });
  it("distinguishes absent media tools from invalid images", async () => {
    fixture.probe.mockRejectedValue(Object.assign(new Error("not installed"), { code: "ENOENT" }));
    await expect(prepareKlingInputs("no-probe", descriptor(), [{ role: "image", sourceUrl: "/api/files/product.png" }])).rejects.toMatchObject({ code: "KLING_MEDIA_TOOL_UNAVAILABLE" });
  });
  it("rejects prompt flags, NUL values, oversized argument vectors and undeclared CLI options", () => {
    expect(() => buildKlingVideoArguments(descriptor(), "--poll", {}, [], "job")).toThrow();
    expect(() => buildKlingVideoArguments(descriptor(), "a\0b", {}, [], "job")).toThrow();
    expect(() => buildKlingVideoArguments(descriptor(), "a".repeat(12001), {}, [], "job")).toThrow();
    expect(() => buildKlingVideoArguments(descriptor(), "valid", { poll: true }, [], "job")).toThrow();
    expect(() => buildKlingVideoArguments({ ...descriptor(), remoteModelId: "--poll" }, "valid", {}, [], "job")).toThrow();
    expect(() => buildKlingVideoArguments(descriptor(), "valid", {}, [], "--quiet")).toThrow();
  });
  it("rejects incomplete or contradictory final prompts at the CLI argument boundary", () => {
    for (const prompt of ["底部小字为“价。", "固定镜头。镜头向左横移。", "视频全程静音。音效：自然环境音贴合画面。"])
      expect(() => buildKlingVideoArguments(descriptor(), prompt, {}, [], "job")).toThrow(expect.objectContaining({ code: "KLING_PROMPT_INVALID" }));
    const prompt = "固定镜头。商品缓缓旋转。显示“价格 2.5 元”。视频全程静音。";
    expect(buildKlingVideoArguments(descriptor(), prompt, {}, [], "job").at(-1)).toBe(prompt);
  });
});
