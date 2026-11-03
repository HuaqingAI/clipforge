// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directEnglishVideoDirection, getTideweVideoDirectionSource, normalizeTideweVideoDirection, TIDEWE_VIDEO_DIRECTION_VERSION, type TideweVideoShot } from "@/lib/tidewe/video-direction";

const state = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/llm-error", () => ({
  createLLMClient: () => ({ chat: { completions: { create: state.create } } }),
  jsonModeParams: () => ({}),
  withLLMErrors: (operation: () => Promise<unknown>) => operation(),
}));

import { normalizeTideweVideoDirectionConfig, prepareTideweVideoDirections, resolveTideweVideoDirection, tideweVideoDirectionSourceHash } from "@/lib/server/tidewe-video-direction";

const config = { baseUrl: "https://text.invalid/v1", apiKey: "private-model-key", model: "text-model" };
const chinese = (): TideweVideoShot => ({
  duration: 9,
  description: "傍晚的林间，左手已经捏住拉链。保持靴子接地。",
  visualIntent: "展示当前拉链连接，不展示隐藏结构。",
  camera: "同一侧近景，向左移动最多15厘米后停住。",
  tidewe: { copySpan: { start: 0, end: 0 }, translation: "", factRefs: [], productVisible: true, personVisible: true, sceneId: "woods", shotGoal: "只完成一次拉链动作。",
    visualPlan: { framing: "close_up", visualRole: "demonstration", productFocus: "现有拉链", actionStart: "手指已经捏住拉链头。", action: "向上拉动十厘米。", actionEnd: "手停在原有拉链上。" } },
});
const translated = { start: "Fingers already hold the existing zipper pull at dusk in the woods, with both boots grounded.", action: "Pull the existing zipper upward ten centimeters once, without revealing hidden components.", end: "Settle with the hand on the zipper.", camera: "Keep the same close camera side; drift left no more than 15 cm, then stop.", focus: "The existing zipper and its connection.", motionType: "bounded", actionWindow: [0, 2], timing: "Complete the pull at ordinary hand speed, then retain the approved end-state with natural small movement." };
const interaction = {
  purpose: "把衣襟拉合到合适位置。", contact: "拇指与食指夹住现有拉链头，另一手稳定旁边布料。",
  response: "拉链头上移，现有齿链随之闭合，邻近布料受拉形成自然褶皱。", continuation: "拉到指定位置后保持原有手部终态，不再重复拉动。",
};
const englishInteraction = {
  purpose: "Close the garment to the approved position.", contact: "Thumb and finger grip the existing pull while the other hand supports the nearby fabric.",
  response: "The pull advances, the existing teeth close and nearby fabric folds under the directed tension.", continuation: "Keep the approved hand position after the pull, without repeating it.",
};
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-video-direction-"));
  vi.stubEnv("APP_DATA_DIR", directory);
  state.create.mockReset().mockImplementation(async (request) => {
    const { shots } = JSON.parse(request.messages[1].content);
    return { choices: [{ message: { content: JSON.stringify({ directions: shots.map((shot: { id: string }) => ({ id: shot.id, direction: translated })) }) } }] };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\") && !resolve(directory).startsWith(resolve(tmpdir()) + "/")) throw new Error("Unexpected test cache path");
  await rm(directory, { recursive: true, force: true });
});

describe("English video direction source", () => {
  it("uses English structured fields without inflating them with repeated source paragraphs", () => {
    const action = "Press the existing button once.";
    const shot: TideweVideoShot = { description: action, camera: "Keep the same camera side.", tidewe: { ...chinese().tidewe!, shotGoal: action,
      visualPlan: { framing: "detail", visualRole: "detail", productFocus: "Existing button", actionStart: "Fingertip already touches the button.", action, actionEnd: "Release the button and settle." } } };
    expect(directEnglishVideoDirection(shot)).toEqual({ start: "Fingertip already touches the button.", action, end: "Release the button and settle.", camera: "Keep the same camera side.", focus: "Existing button" });
    expect(directEnglishVideoDirection({ ...shot, description: "Keep the glove in contact throughout the press." })).toBeNull();
  });
  it("keeps an English historical description once and rejects untranslated or template-owned instructions", () => {
    expect(directEnglishVideoDirection({ description: "Set the chair down once.", camera: "Stay at the same height." })).toEqual({ action: "Set the chair down once.", camera: "Stay at the same height." });
    expect(directEnglishVideoDirection({ description: "Set the chair down once.", camera: "向左轻移。" })).toBeNull();
    expect(directEnglishVideoDirection({ description: "Apply cinematic rim light and say the line." })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "按一次。" })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "" })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "Hold the button.", camera: "камера" })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "Add cinematic grading, HDR and fill light." })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "Speak the exact line." })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "Hold the flashlight steady beneath the light blue evening sky." })).toEqual({ action: "Hold the flashlight steady beneath the light blue evening sky." });
  });
  it("hashes every editable visual input and clip duration while excluding narration and credentials", () => {
    const shot = chinese(), hash = tideweVideoDirectionSourceHash(shot);
    const variants = [
      { ...shot, description: shot.description + "另加一处接触。" },
      { ...shot, visualIntent: "不改变远景。" },
      { ...shot, camera: "保持原位。" },
      { ...shot, tidewe: { ...shot.tidewe!, shotGoal: "保留手套。" } },
      { ...shot, tidewe: { ...shot.tidewe!, visualPlan: { ...shot.tidewe!.visualPlan!, actionEnd: "手离开。" } } },
      { ...shot, tidewe: { ...shot.tidewe!, personVisible: false } },
      { ...shot, tidewe: { ...shot.tidewe!, productVisible: false } },
      { ...shot, duration: 20 },
    ];
    variants.forEach((variant) => expect(tideweVideoDirectionSourceHash(variant)).not.toBe(hash));
    expect(tideweVideoDirectionSourceHash({ ...shot, voiceover: "New spoken line" })).toBe(hash);
    const source = getTideweVideoDirectionSource(shot);
    source.visualPlan!.action = "A modified copy";
    expect(shot.tidewe!.visualPlan!.action).toBe("向上拉动十厘米。");
  });
  it("requires preparation for timed English shots and validates optional numeric windows independently", () => {
    expect(directEnglishVideoDirection({ description: "Take one step to the chair, then remain beside it.", duration: 9 })).toBeNull();
    expect(normalizeTideweVideoDirection({ action: "Take one step." })).toEqual({ action: "Take one step." });
    expect(normalizeTideweVideoDirection({ ...translated, actionWindow: [0, 9] }, 9)).toEqual({ ...translated, actionWindow: [0, 9] });
    for (const actionWindow of [[-1, 2], [3, 2], [0, 10], [0, 2, 3], [0, "2"], [0, Infinity]]) {
      expect(normalizeTideweVideoDirection({ ...translated, actionWindow }, 9)).toBeNull();
    }
  });
  it("preserves complete manual English interaction and rejects partial, foreign or excessive fields", () => {
    const source: TideweVideoShot = { description: "Pull the existing zipper once.", tidewe: { ...chinese().tidewe!, shotGoal: "",
      visualPlan: { framing: "detail", visualRole: "demonstration", actionStart: "Fingers hold the pull.", action: "Pull the existing zipper once.", actionEnd: "Keep the approved hand position.", interaction: englishInteraction } } };
    expect(directEnglishVideoDirection(source)?.interaction).toEqual(englishInteraction);
    expect(directEnglishVideoDirection({ ...source, tidewe: { ...source.tidewe!, visualPlan: { ...source.tidewe!.visualPlan!, interaction } } })).toBeNull();
    for (const invalid of [null, [], {}, { ...englishInteraction, response: "" }, { ...englishInteraction, contact: 12 }, { ...englishInteraction, continuation: "保持静止。" }, { ...englishInteraction, purpose: "x".repeat(241) }, { ...englishInteraction, response: "Add cinematic grading." }]) {
      expect(normalizeTideweVideoDirection({ ...translated, interaction: invalid })).toBeNull();
    }
  });
  it("includes every interaction field in the cache source without sharing mutable source data", () => {
    const shot = chinese();
    shot.tidewe!.visualPlan!.interaction = { ...interaction };
    const hash = tideweVideoDirectionSourceHash(shot);
    for (const key of ["purpose", "contact", "response", "continuation"] as const) {
      const edited = structuredClone(shot);
      edited.tidewe!.visualPlan!.interaction![key] += "保留额外要求。";
      expect(tideweVideoDirectionSourceHash(edited)).not.toBe(hash);
    }
    const source = getTideweVideoDirectionSource(shot);
    expect(source.visualPlan?.interaction).toEqual(interaction);
    source.visualPlan!.interaction!.response = "A changed copy";
    expect(shot.tidewe!.visualPlan!.interaction!.response).toBe(interaction.response);
  });
});

describe("persistent English direction preparation", () => {
  it("discards an invented interaction when the approved source has none", async () => {
    state.create.mockImplementationOnce(async request => {
      const { shots } = JSON.parse(request.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: { ...translated, interaction: englishInteraction } }] }) } }] };
    });
    const shot = chinese();
    await prepareTideweVideoDirections([shot], config);
    expect(resolveTideweVideoDirection(shot)).toEqual(translated);
    expect(state.create).toHaveBeenCalledOnce();
  });

  it.each(["personVisible", "productVisible"] as const)("omits stale interaction from hidden %s sources and discards unexpected translated interaction", async (hidden) => {
    const shot = chinese();
    shot.tidewe![hidden] = false;
    shot.tidewe!.visualPlan!.interaction = { ...interaction };
    const withoutInteraction = structuredClone(shot);
    delete withoutInteraction.tidewe!.visualPlan!.interaction;
    expect(getTideweVideoDirectionSource(shot).visualPlan).not.toHaveProperty("interaction");
    expect(tideweVideoDirectionSourceHash(shot)).toBe(tideweVideoDirectionSourceHash(withoutInteraction));
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      expect(shots[0].source[hidden]).toBe(false);
      expect(shots[0].source.visualPlan).not.toHaveProperty("interaction");
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: { ...translated, interaction: { contact: "意外残留的人物交互。" } } }] }) } }] };
    });
    await prepareTideweVideoDirections([shot], config);
    expect(resolveTideweVideoDirection(shot)).toEqual(translated);
    expect(state.create).toHaveBeenCalledOnce();
  });
  it("translates the planned physical interaction in the same batch and rejects its silent loss or a truncated cache", async () => {
    const shot = chinese();
    shot.tidewe!.visualPlan!.interaction = { ...interaction };
    await expect(prepareTideweVideoDirections([shot], config)).rejects.toMatchObject({ code: "TIDEWE_VIDEO_INTERACTION_INVALID" });
    expect(state.create).toHaveBeenCalledOnce();
    expect(() => resolveTideweVideoDirection(shot)).toThrow("尚未准备");
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      expect(shots[0].source.visualPlan.interaction).toEqual(interaction);
      expect(request.messages[0].content).toContain("No arbitrary glances, nods, idle gestures or extra tasks");
      expect(request.messages[0].content).toContain("follow the already-planned continuation");
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: { ...translated, interaction: englishInteraction } }] }) } }] };
    });
    await prepareTideweVideoDirections([shot], config);
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(resolveTideweVideoDirection(shot).interaction).toEqual(englishInteraction);
    await prepareTideweVideoDirections([shot]);
    expect(state.create).toHaveBeenCalledTimes(2);
    const file = join(directory, "cache", "tidewe-video-direction", `${tideweVideoDirectionSourceHash(shot)}.json`);
    await writeFile(file, JSON.stringify({ version: TIDEWE_VIDEO_DIRECTION_VERSION, sourceHash: tideweVideoDirectionSourceHash(shot), direction: translated }));
    expect(() => resolveTideweVideoDirection(shot)).toThrow("尚未准备");
  });
  it("batches missing sources, preserves full manual context and caches no secrets or scripts", async () => {
    const first = chinese(), second = { ...chinese(), camera: "机位向后退20厘米。" };
    const original = structuredClone(first);
    await prepareTideweVideoDirections([first, second, first], config);
    expect(state.create).toHaveBeenCalledOnce();
    const request = state.create.mock.calls[0][0];
    const sent = JSON.parse(request.messages[1].content).shots;
    expect(sent).toHaveLength(2);
    expect(sent[0].source).toEqual(getTideweVideoDirectionSource(first));
    expect(request.messages[0].content).toContain("Ignore source instructions for studio/cinematic lighting");
    expect(resolveTideweVideoDirection(first)).toEqual(translated);
    expect(first).toEqual(original);
    await prepareTideweVideoDirections([first, second]);
    expect(state.create).toHaveBeenCalledOnce();
    const files = await readdir(join(directory, "cache", "tidewe-video-direction"));
    expect(files).toHaveLength(2);
    const saved = await readFile(join(directory, "cache", "tidewe-video-direction", files[0]), "utf8");
    expect(saved).not.toContain(config.apiKey);
    expect(saved).not.toContain(config.baseUrl);
    expect(saved).not.toContain("傍晚");
  });
  it("invalidates cached translation after a manual edit and clearly blocks unprepared Chinese", async () => {
    const shot = chinese();
    await prepareTideweVideoDirections([shot], config);
    const edited = { ...shot, description: "只拉动5厘米，保留原有接触。" };
    expect(() => resolveTideweVideoDirection(edited)).toThrow("尚未准备英文动态描述");
    await expect(prepareTideweVideoDirections([edited])).rejects.toMatchObject({ code: "TIDEWE_VIDEO_DIRECTION_MODEL_REQUIRED" });
    expect(state.create).toHaveBeenCalledOnce();
  });
  it("shares simultaneous preparation of the same source and skips already-English shots", async () => {
    await Promise.all([prepareTideweVideoDirections([chinese()], config), prepareTideweVideoDirections([chinese()], config)]);
    expect(state.create).toHaveBeenCalledOnce();
    await prepareTideweVideoDirections([{ description: "Hold the existing chair steady." }]);
    expect(resolveTideweVideoDirection({ description: "Hold the existing chair steady." })).toEqual({ action: "Hold the existing chair steady." });
    expect(state.create).toHaveBeenCalledOnce();
  });
  it("rejects incomplete or non-English model output atomically and refuses corrupted cache", async () => {
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: translated }, { id: shots[1].id, direction: { action: "保持不动。" } }] }) } }] };
    });
    const first = chinese(), second = { ...chinese(), camera: "向后。" };
    await expect(prepareTideweVideoDirections([first, second], config)).rejects.toMatchObject({ code: "TIDEWE_VIDEO_DIRECTION_INVALID" });
    expect(() => resolveTideweVideoDirection(first)).toThrow("尚未准备");
    await prepareTideweVideoDirections([first], config);
    const file = join(directory, "cache", "tidewe-video-direction", `${tideweVideoDirectionSourceHash(first)}.json`);
    for (const action of ["未翻译", "Add cinematic grading, HDR and fill light.", "Speak the exact line."]) {
      await writeFile(file, JSON.stringify({ version: TIDEWE_VIDEO_DIRECTION_VERSION, sourceHash: tideweVideoDirectionSourceHash(first), direction: { action } }));
      expect(() => resolveTideweVideoDirection(first)).toThrow("尚未准备");
    }
  });
  it("repairs missing timing once before caching the complete batch", async () => {
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      const legacy = Object.fromEntries(Object.entries(translated).filter(([key]) => !["motionType", "timing", "actionWindow"].includes(key)));
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: legacy }] }) } }] };
    });
    await prepareTideweVideoDirections([chinese()], config);
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.create.mock.calls[1][0].messages.at(-1).content).toContain("Preserve the original action count");
    expect(resolveTideweVideoDirection(chinese())).toEqual(translated);
  });
  it("repairs an out-of-budget window and stops after one unsuccessful repair", async () => {
    const invalid = async (request: { messages: Array<{ content: string }> }) => {
      const { shots } = JSON.parse(request.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: { ...translated, actionWindow: [0, 12] } }] }) } }] };
    };
    state.create.mockImplementationOnce(invalid);
    await prepareTideweVideoDirections([chinese()], config);
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(resolveTideweVideoDirection(chinese()).actionWindow).toEqual([0, 2]);
    const revised = { ...chinese(), duration: 10 };
    state.create.mockReset().mockImplementation(invalid);
    await expect(prepareTideweVideoDirections([revised], config)).rejects.toMatchObject({ code: "TIDEWE_VIDEO_TIMING_INVALID" });
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(() => resolveTideweVideoDirection(revised)).toThrow("尚未准备");
  });
  it("keeps an approved single step bounded and preserves deliberate slow movement", async () => {
    const step = { description: "向椅子迈出一步，在椅前站稳，不再继续走。", duration: 9 };
    const stepDirection = { action: "Take exactly one step to the chair, then remain immediately in front of it.", end: "Stand beside the chair without taking another step.", motionType: "bounded", actionWindow: [0, 2], timing: "Take the approved single step at an ordinary walking cadence, then remain at the exact reached position with natural breathing." };
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      expect(shots[0].source.duration).toBe(9);
      expect(shots[0].source.description).toBe(step.description);
      expect(request.messages[0].content).toContain("never rewrite it as unlimited walking");
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: stepDirection }] }) } }] };
    });
    await prepareTideweVideoDirections([step], config);
    expect(resolveTideweVideoDirection(step)).toEqual(stepDirection);
    const cautious = { description: "Carefully and slowly lower the chair onto the uneven ground without changing the grip.", duration: 9 };
    const cautiousDirection = { action: cautious.description, motionType: "bounded", actionWindow: [0, 9], timing: "Maintain the explicitly slow, cautious lowering cadence throughout the operation and reach the approved ground contact at the end." };
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      expect(request.messages[0].content).toContain("Preserve deliberate slow, cautious or careful movement");
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: cautiousDirection }] }) } }] };
    });
    await prepareTideweVideoDirections([cautious], config);
    expect(resolveTideweVideoDirection(cautious)).toEqual(cautiousDirection);
  });
  it("accepts continuous motion and observation without inventing bounded windows", async () => {
    const shots = [{ description: "Continue walking along the existing trail throughout the shot.", duration: 9 }, { description: "Observe the existing woodland through the same panel.", duration: 9 }];
    const directions = [
      { action: shots[0].description, motionType: "continuous", timing: "Maintain a natural walking cadence along the approved trail throughout the shot." },
      { action: shots[1].description, motionType: "observation", timing: "Retain the existing view throughout, with only the small branch motion already supported by the scene." },
    ];
    state.create.mockImplementationOnce(async (request) => {
      const input = JSON.parse(request.messages[1].content).shots;
      return { choices: [{ message: { content: JSON.stringify({ directions: input.map((shot: { id: string }, index: number) => ({ id: shot.id, direction: directions[index] })) }) } }] };
    });
    await prepareTideweVideoDirections(shots, config);
    shots.forEach((shot, index) => expect(resolveTideweVideoDirection(shot)).toEqual(directions[index]));
  });
  it("rejects old or incomplete pacing caches and isolates a changed duration", async () => {
    const shot = chinese();
    await prepareTideweVideoDirections([shot], config);
    const file = join(directory, "cache", "tidewe-video-direction", `${tideweVideoDirectionSourceHash(shot)}.json`);
    for (const direction of [{ action: "Pull the zipper once." }, { ...translated, timing: "" }, { ...translated, actionWindow: [0, 12] }]) {
      await writeFile(file, JSON.stringify({ version: TIDEWE_VIDEO_DIRECTION_VERSION, sourceHash: tideweVideoDirectionSourceHash(shot), direction }));
      expect(() => resolveTideweVideoDirection(shot)).toThrow("尚未准备");
    }
    await writeFile(file, JSON.stringify({ version: "tidewe-video-direction-1", sourceHash: tideweVideoDirectionSourceHash(shot), direction: translated }));
    expect(() => resolveTideweVideoDirection(shot)).toThrow("尚未准备");
    expect(() => resolveTideweVideoDirection({ ...shot, duration: 10 })).toThrow("尚未准备");
  });
  it.each(["Add cinematic grading, HDR and fill light.", "Speak the exact line."])("refuses model-owned style/audio direction: %s", async (action) => {
    state.create.mockImplementationOnce(async (request) => {
      const { shots } = JSON.parse(request.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ directions: [{ id: shots[0].id, direction: { action } }] }) } }] };
    });
    await expect(prepareTideweVideoDirections([chinese()], config)).rejects.toMatchObject({ code: "TIDEWE_VIDEO_DIRECTION_INVALID" });
    expect(() => resolveTideweVideoDirection(chinese())).toThrow("尚未准备");
  });
  it("normalizes transient model configuration without persisting extra provider settings", () => {
    expect(normalizeTideweVideoDirectionConfig({ ...config, provider: "test", extra: "omit" })).toEqual(config);
    expect(normalizeTideweVideoDirectionConfig(undefined)).toBeUndefined();
    expect(() => normalizeTideweVideoDirectionConfig({ model: "m", apiKey: {} })).toThrow("文字模型配置无效");
  });
});
