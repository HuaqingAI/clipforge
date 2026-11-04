// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn(), jsonMode: vi.fn() }));
vi.mock("@/lib/llm-error", () => ({
  createLLMClient: (config: unknown) => { state.client(config); return { chat: { completions: { create: state.create } } }; },
  jsonModeParams: (baseUrl: string) => { state.jsonMode(baseUrl); return { response_format: { type: "json_object" } }; },
  withLLMErrors: (operation: () => Promise<unknown>) => operation(),
}));

import { generateComposeHeadline, normalizeComposeHeadlineConfig } from "@/lib/server/compose-headline";

const config = { baseUrl: "https://text.invalid/v1", apiKey: "private-model-key", model: "configured-text-model" };
const input = {
  copy: "A little creek should not end your hunt. These TIDEWE boots are waterproof for wet crossings and muddy approaches. Adjustable straps fit the tops around your calves. Reinforced toes add wear resistance up front.",
  productName: "TIDEWE rubber boots",
};
const headline = "Keep Hunting Through Wet Crossings";
function response(title: unknown) { return { choices: [{ message: { content: JSON.stringify({ title }) } }] }; }
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-compose-headline-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.create.mockReset().mockResolvedValue(response(headline));
  state.client.mockReset();
  state.jsonMode.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("whole-video compose headline", () => {
  it("sends the entire final narration to the configured text model and demands a grounded English summary", async () => {
    await expect(generateComposeHeadline(input, config)).resolves.toBe(headline);
    expect(state.client).toHaveBeenCalledWith(config);
    const [request, options] = state.create.mock.calls[0];
    expect(request.model).toBe(config.model);
    expect(JSON.parse(request.messages[1].content)).toEqual({ fullNarration: input.copy, productName: input.productName });
    expect(request.messages[0].content).toContain("ENTIRE supplied video narration");
    expect(request.messages[0].content).toContain("not simply reuse its opening line");
    expect(request.messages[0].content).toContain("Do not invent features");
    expect(request.messages[0].content).toContain('JSON {"title"');
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(state.jsonMode).toHaveBeenCalledWith(config.baseUrl);
    expect(options).toMatchObject({ timeout: 120_000, maxRetries: 0, signal: expect.any(AbortSignal) });
  });

  it("reuses only matching full-copy/product/model/endpoint results and stores no full copy or credentials", async () => {
    await generateComposeHeadline(input, config);
    await expect(generateComposeHeadline(input, { ...config, apiKey: "rotated-secret" })).resolves.toBe(headline);
    await expect(generateComposeHeadline(input)).resolves.toBe(headline);
    expect(state.create).toHaveBeenCalledOnce();
    const cacheDir = join(directory, "cache", "compose-headline");
    const files = await readdir(cacheDir);
    expect(files).toHaveLength(2);
    const content = (await Promise.all(files.map(file => readFile(join(cacheDir, file), "utf8")))).join("\n");
    for (const secret of [config.apiKey, "rotated-secret", config.baseUrl, config.model, input.copy, input.productName]) expect(content).not.toContain(secret);
    expect(content).toContain(headline);

    await generateComposeHeadline({ ...input, copy: `${input.copy} Wet leaves are also on the route.` }, config);
    await generateComposeHeadline({ ...input, productName: "Another rubber boot" }, config);
    await generateComposeHeadline(input, { ...config, model: "another-model" });
    await generateComposeHeadline(input, { ...config, baseUrl: "https://other.invalid/v1" });
    expect(state.create).toHaveBeenCalledTimes(5);
  });

  it("with no model requires settings on a miss and never falls back to a first sentence", async () => {
    await expect(generateComposeHeadline(input)).rejects.toThrow(/设置中配置文字模型/);
    expect(state.create).not.toHaveBeenCalled();
    await generateComposeHeadline(input, config);
    await expect(generateComposeHeadline({ ...input, copy: `${input.copy} Additional final sentence.` })).rejects.toThrow(/配置文字模型/);
    await expect(generateComposeHeadline({ ...input, productName: "Another product" })).rejects.toThrow(/配置文字模型/);
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("updates the no-config source index to the most recently selected matching model", async () => {
    state.create.mockResolvedValueOnce(response("Cross Wet Terrain With Dry Feet"))
      .mockResolvedValueOnce(response("Rubber Boots for Wet Hunting Routes"));
    const first = await generateComposeHeadline(input, config);
    const second = await generateComposeHeadline(input, { ...config, model: "other-model" });
    await expect(generateComposeHeadline(input)).resolves.toBe(second);
    await expect(generateComposeHeadline(input, config)).resolves.toBe(first);
    await expect(generateComposeHeadline(input)).resolves.toBe(first);
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty", ""],
    ["non-English", "这双靴子让你穿过泥泞地面"],
    ["multiline", "Keep Hunting\nThrough Wet Crossings"],
    ["too short", "Dry Feet"],
    ["too many words", "Keep Your Feet Dry When You Go To The Creek Today"],
    ["too long", "Waterproof Protection During Exceptionally Challenging Outdoor Crossings"],
    ["first sentence", "A little creek should not end your hunt"],
    ["opening words", "A little creek should not"],
    ["invented guarantee", "Guaranteed Dry Feet for Every Hunt"],
    ["invented number", "Stay Dry for 100 Hours"],
  ])("corrects an invalid %s response once without taking a copy fallback", async (_reason, invalid) => {
    state.create.mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(headline));
    await expect(generateComposeHeadline(input, config)).resolves.toBe(headline);
    expect(state.create).toHaveBeenCalledTimes(2);
    const correction = state.create.mock.calls[1][0].messages;
    expect(correction.at(-1).content).toContain("entire original narration");
    expect(JSON.parse(correction[1].content).fullNarration).toBe(input.copy);
  });

  it("rejects repeated invalid or malformed JSON responses without caching a fabricated title", async () => {
    state.create.mockResolvedValue({ choices: [{ message: { content: "not JSON" } }] });
    await expect(generateComposeHeadline(input, config)).rejects.toThrow(/未生成有效/);
    expect(state.create).toHaveBeenCalledTimes(2);
    await expect(generateComposeHeadline(input)).rejects.toThrow(/配置文字模型/);
  });

  it("accepts JSON inside provider fences/reasoning wrappers while rejecting unexpected fields", async () => {
    state.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ title: headline, unsupportedField: true }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: `<think>model notes</think>\n\x60\x60\x60json\n${JSON.stringify({ title: headline })}\n\x60\x60\x60` } }] });
    await expect(generateComposeHeadline(input, config)).resolves.toBe(headline);
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it("treats a tampered or invalid cached title as a miss", async () => {
    await generateComposeHeadline(input, config);
    const cacheDir = join(directory, "cache", "compose-headline");
    const filename = (await readdir(cacheDir)).find(file => !file.endsWith(".index.json"))!;
    const record = JSON.parse(await readFile(join(cacheDir, filename), "utf8"));
    record.title = "A little creek should not end your hunt";
    await writeFile(join(cacheDir, filename), JSON.stringify(record));
    await expect(generateComposeHeadline(input)).rejects.toThrow(/配置文字模型/);
    await expect(generateComposeHeadline(input, config)).resolves.toBe(headline);
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent identical model calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.create.mockImplementation(async () => { await gate; return response(headline); });
    const first = generateComposeHeadline(input, config);
    const second = generateComposeHeadline(input, config);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([headline, headline]);
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("does not expose credentials in provider failures or perform a format retry for transport errors", async () => {
    state.create.mockRejectedValue(new Error(`Unable to fetch ${config.baseUrl} using ${config.apiKey}`));
    const error = await generateComposeHeadline(input, config).catch(error => error);
    expect(error.message).toContain("检查文字模型");
    expect(error.message).not.toContain(config.baseUrl);
    expect(error.message).not.toContain(config.apiKey);
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("validates configuration and required full narration without touching a model", async () => {
    expect(normalizeComposeHeadlineConfig(undefined)).toBeUndefined();
    expect(normalizeComposeHeadlineConfig({ model: "  " })).toBeUndefined();
    expect(normalizeComposeHeadlineConfig({ model: " m " })).toEqual({ model: "m", baseUrl: "", apiKey: "" });
    for (const invalid of ["bad", [], { model: 1 }, { model: "m", apiKey: {} }, { model: "m", baseUrl: 42 }]) {
      expect(() => normalizeComposeHeadlineConfig(invalid)).toThrow(/配置无效/);
    }
    await expect(generateComposeHeadline({ copy: "" }, config)).rejects.toThrow(/完整视频文案/);
    expect(state.create).not.toHaveBeenCalled();
  });
});
