// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateScript, generateSingleScript, generateTopicScript, type ScriptInput } from "@/lib/script-engine/generator";

const model = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/llm-error", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/llm-error")>(),
  createLLMClient: () => ({ chat: { completions: { create: model.create } } }),
}));

const llmConfig = { baseUrl: "https://example.test/v1", apiKey: "test", model: "test" };
const input: ScriptInput = { productName: "Travel mug", category: "home", styleType: "pain_point", llmConfig };
const generated = {
  title: "My first draft", totalDuration: 3,
  shots: [{ duration: 3, description: "A mug on a desk.", voiceover: "Ready for the next trip." }],
};
const reply = (content: string) => ({ choices: [{ message: { content } }] });
const entrypoints = [
  { name: "commerce batch", run: () => generateScript(input) },
  { name: "single commerce script", run: async () => [await generateSingleScript(input)] },
  { name: "topic script", run: () => generateTopicScript({ topic: "Morning routines", llmConfig }) },
];

beforeEach(() => { model.create.mockReset(); });

describe("direct script generation", () => {
  it.each(entrypoints)("applies the first $name response with one model call", async ({ run }) => {
    model.create.mockResolvedValue(reply(JSON.stringify(generated)));
    const scripts = await run();
    expect(model.create).toHaveBeenCalledOnce();
    expect(scripts[0]).toMatchObject({ title: generated.title, shots: [{ voiceover: generated.shots[0].voiceover }] });
  });

  it.each(entrypoints)("reports malformed $name output without asking the model to repair it", async ({ run }) => {
    model.create.mockResolvedValueOnce(reply("This is not JSON"));
    model.create.mockResolvedValueOnce(reply(JSON.stringify(generated)));
    await expect(run()).rejects.toThrow(/JSON/);
    expect(model.create).toHaveBeenCalledOnce();
  });

  it("keeps generated content without filtering silent candidates or running another quality pass", async () => {
    model.create.mockResolvedValue(reply(JSON.stringify({ scripts: [
      { ...generated, title: "Silent draft", shots: [{ ...generated.shots[0], voiceover: "" }] },
      generated,
    ] })));
    const scripts = await generateScript(input);
    expect(scripts.map(script => script.title)).toEqual(["Silent draft", generated.title]);
    expect(model.create).toHaveBeenCalledOnce();
  });
});
