// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractGenerationId, extractPrincipal, modelSelectionKey, normalizeKlingTask, parseCatalog, parseCliJson } from "./protocol";
import { KLING_AUDIO_PARAMETER_NAMES, klingHasDefaultNativeAudio, klingSupportsNativeAudio } from "./model-options";

describe("Kling fixed-version protocol", () => {
  it("parses envelopes and diagnostic-surrounded JSON without inventing a response", () => {
    expect(parseCliJson('diagnostic\n{"ok":true,"body":{"generation_id":"job-123"}}\n')).toEqual({ ok: true, body: { generation_id: "job-123" } });
    expect(parseCliJson("<html>website</html>")).toBeUndefined();
    expect(parseCliJson("\uFEFF{\"ok\":true}")).toEqual({ ok: true });
  });
  it("retains an acknowledged ID even in a remote error envelope", () => {
    expect(extractGenerationId({ ok: false, body: { generationId: "job-123" } })).toBe("job-123");
    expect(extractGenerationId({ body: { generationId: "bad\nvalue" } })).toBeUndefined();
  });
  it("normalizes both official catalog layouts and keeps tool identities distinct", () => {
    const catalog = parseCatalog({ ok: true, body: { available_models: {
      text_to_video: [{ model: "kling:alpha", arguments: [{ name: "duration", required: true, allowed_values: [5, 10], default: 5 }] }],
      image_to_video: { models: [{ model: "kling:alpha", inputs: [{ name: "first_frame", required: true }, { name: "tail_image" }] }] },
    } } }, "profile");
    expect(catalog).toHaveLength(2);
    expect(catalog[0].selectionKey).not.toBe(catalog[1].selectionKey);
    expect(catalog[0].parameters[0]).toMatchObject({ type: "number", allowedValues: [5, 10] });
    expect(catalog[1].capabilities).toEqual({ image: true, tailFrame: true, multiImage: true, audio: true });
    expect(catalog[0].catalogRevision).toBe(catalog[1].catalogRevision);
    expect(JSON.parse(modelSelectionKey("text_to_video", "x:y"))).toEqual(["kling-cli", "text_to_video", "x:y"]);
  });
  it("retains safe new scalar parameters and keeps models available when input metadata is unfamiliar", () => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: "m", arguments: [{ name: "future_arg", required: true }], inputs: [{ name: "audio_file", required: true }] }] } }, "p");
    expect(model.available).toBe(true);
    expect(model.disabledReason).toBeUndefined();
    expect(model.parameters).toEqual([{ name: "future_arg", required: true, type: "string" }]);
    expect(model.capabilities).toEqual({ image: true, tailFrame: true, multiImage: true, audio: true });
  });
  it("keeps capability revisions stable when catalog, parameter, value and image-slot ordering changes", () => {
    const duration = { name: "duration", required: true, type: "number", allowedValues: [5, 10], default: 5 };
    const sound = { name: "sound", required: false, type: "string", allowedValues: ["on", "off"], default: "off" };
    const a = parseCatalog({ availableModels: { image_to_video: [
      { model: "alpha", arguments: [duration, sound], inputs: [{ name: "first_frame", required: true }, { name: "tail_image", required: false }] },
      { model: "beta", arguments: [duration] },
    ] } }, "profile");
    const b = parseCatalog({ availableModels: { image_to_video: [
      { model: "beta", arguments: [{ ...duration, allowedValues: [10, 5] }] },
      { model: "alpha", arguments: [{ ...sound, allowedValues: ["off", "on"] }, { ...duration, allowedValues: [10, 5] }], inputs: [{ name: "tail_image", required: false }, { name: "first_frame", required: true }] },
    ] } }, "profile");
    expect(a[0].catalogRevision).toBe(b[0].catalogRevision);
    expect(a[0].parameters[0].name).toBe("duration"); expect(b[1].parameters[0].name).toBe("sound");
  });
  it("excludes display-only metadata and local profile identity from the capability revision", () => {
    const raw = { model: "alpha", alias: "Model Alpha", description: "First description", arguments: [{ name: "duration", allowedValues: [5, 10], default: 5, description: "seconds" }] };
    const [a] = parseCatalog({ availableModels: { text_to_video: [raw] } }, "profile-a");
    const [b] = parseCatalog({ availableModels: { text_to_video: [{ ...raw, alias: "New label", description: "Updated prose", arguments: [{ ...raw.arguments[0], description: "Updated help text" }] }] } }, "profile-b");
    expect(a.catalogRevision).toBe(b.catalogRevision); expect(a.displayName).not.toBe(b.displayName);
  });
  it.each([
    { name: "duration_seconds", required: true, type: "number", allowedValues: [5, 10], default: 5 },
    { name: "duration", required: false, type: "number", allowedValues: [5, 10], default: 5 },
    { name: "duration", required: true, type: "string", allowedValues: ["5", "10"], default: "5" },
    { name: "duration", required: true, type: "number", allowedValues: [5, 10], default: 10 },
    { name: "duration", required: true, type: "number", allowedValues: [5, 15], default: 5 },
  ])("changes revision for altered parameter semantics: %j", (parameter) => {
    const revision = (argument: unknown) => parseCatalog({ availableModels: { text_to_video: [{ model: "alpha", arguments: [argument] }] } }, "p")[0].catalogRevision;
    expect(revision(parameter)).not.toBe(revision({ name: "duration", required: true, type: "number", allowedValues: [5, 10], default: 5 }));
  });
  it("changes revision when model identity, tool or required image roles change", () => {
    const revision = (tool: string, model: string, inputs: unknown[]) => parseCatalog({ availableModels: { [tool]: [{ model, inputs }] } }, "p")[0].catalogRevision;
    const original = revision("image_to_video", "alpha", [{ name: "first_frame", required: true }, { name: "tail_image", required: false }]);
    expect(revision("image_to_video", "beta", [{ name: "first_frame", required: true }, { name: "tail_image", required: false }])).not.toBe(original);
    expect(revision("text_to_video", "alpha", [])).not.toBe(original);
    expect(revision("image_to_video", "alpha", [{ name: "first_frame", required: true }, { name: "tail_image", required: true }])).not.toBe(original);
  });
  it("defaults every capability on even when a model has no capability metadata", () => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: "omni-tail-audio-pro" }] } }, "p");
    expect(model.capabilities).toEqual({ image: true, tailFrame: true, multiImage: true, audio: true });
    expect(klingSupportsNativeAudio(model)).toBe(true);
  });
  it.each(["text_to_video", "image_to_video"] as const)("uses provider audio defaults without inventing a %s audio argument", (tool) => {
    const [model] = parseCatalog({ availableModels: { [tool]: [{ model: "kling-video-v4_0", arguments: [
      { name: "duration", type: "number", allowedValues: [5, 10], default: 5 },
      { name: "resolution", allowedValues: ["720p", "1080p"], default: "720p" },
      { name: "aspect_ratio", allowedValues: ["9:16", "16:9"], default: "9:16" },
    ] }] } }, "p");
    expect(model.available).toBe(true);
    expect(model.capabilities.audio).toBe(true);
    expect(model.parameters.some((parameter) => KLING_AUDIO_PARAMETER_NAMES.includes(parameter.name))).toBe(false);
    expect(klingHasDefaultNativeAudio(model)).toBe(true);
    // Stored catalogs from before this correction carried an incorrect false value.
    expect(klingSupportsNativeAudio({ ...model, capabilities: { ...model.capabilities, audio: false } })).toBe(true);
  });
  it.each(["kling-video-v1", "kling-video-v4_0-preview", "kling-video-v4_1", "future-model"])("allows native audio for %s without a model whitelist", (id) => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: id }] } }, "p");
    expect(model.capabilities.audio).toBe(true);
    expect(klingHasDefaultNativeAudio(model)).toBe(true);
    expect(klingSupportsNativeAudio({ ...model, capabilities: { image: false, tailFrame: false, multiImage: false, audio: false } })).toBe(true);
  });
  it.each(["audio_enabled", "audioEnabled"])("retains the declared %s audio switch", (name) => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: "m", arguments: [{ name, type: "boolean", default: false }] }] } }, "p");
    expect(model.parameters).toContainEqual({ name, type: "boolean", required: false, default: false });
    expect(model.capabilities.audio).toBe(true);
    expect(klingSupportsNativeAudio(model)).toBe(true);
  });
  it("uses provider defaults when a declared audio switch has no enable value", () => {
    const [model] = parseCatalog({ availableModels: { image_to_video: [{ model: "kling-video-v4_0", arguments: [{ name: "sound", allowedValues: ["off"], default: "off" }] }] } }, "p");
    expect(klingHasDefaultNativeAudio(model)).toBe(true);
    expect(klingSupportsNativeAudio(model)).toBe(true);
  });
  it("skips non-scalar catalog fields without disabling generation", () => {
    const [model] = parseCatalog({ availableModels: { text_to_video: [{ model: "m", arguments: [{ name: "future", required: false }, { name: "duration", required: true, type: "array", allowedValues: [[5]] }] }] } }, "p");
    expect(model.available).toBe(true);
    expect(model.parameters).toEqual([{ name: "future", required: false, type: "string" }]);
  });
  it("binds explicit user IDs and refuses display text or generic request IDs", () => {
    expect(extractPrincipal({ body: { user_id: "u-1", nickname: "test" } })).toEqual({ principalKey: '["global","u-1"]', accountSummary: { id: "u-1", displayName: "test" } });
    expect(() => extractPrincipal({ body: { id: "request-id", email: "user@example.test", nickname: "name" } })).toThrow(/稳定账号 ID/);
  });
  it("uses stable output identities when URLs rotate their signatures or work ordering changes", () => {
    const a = normalizeKlingTask({ body: { status: "completed", works: [{ url: "https://cdn.example.test/a.mp4?token=one" }, { url: "https://cdn.example.test/b.mp4?token=one" }] } });
    const b = normalizeKlingTask({ body: { status: "succeed", works: [{ url: "https://cdn.example.test/b.mp4?token=two" }, { url: "https://cdn.example.test/a.mp4?token=two" }] } });
    expect(a.status).toBe("succeeded"); expect(a.works[0].id).toBe(b.works[1].id);
    expect(a.works[1].id).toBe(b.works[0].id);
  });
  it("filters explicit non-video works and refuses root URLs without a stable work ID", () => {
    expect(normalizeKlingTask({ body: { status: "completed", works: [{ type: "image", url: "https://cdn.example.test/a.png" }, { mediaType: "audio", url: "https://cdn.example.test/a.mp3" }, { id: "v", type: "video", url: "https://cdn.example.test/a.mp4" }] } }).works).toHaveLength(1);
    expect(() => normalizeKlingTask({ body: { works: [{ url: "https://cdn.example.test/?signature=random" }] } })).toThrow(/稳定作品 ID/);
  });
  it("keeps unknown remote status unknown rather than completing or resubmitting", () => {
    expect(normalizeKlingTask({ body: { status: "future_status", generation_id: "g" } })).toMatchObject({ status: "unknown", generationId: "g", works: [] });
  });
});
