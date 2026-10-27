import { beforeEach, describe, expect, it, vi } from "vitest";
import { configuredCatalogProviders } from "@/lib/model-catalog";
import { mergeCustomModels, resolveDefaultModelTarget } from "@/lib/gen-params";
import type { CustomModel } from "@/lib/gen-params";

const guardedFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kling/client", () => ({ klingFetch: guardedFetch }));

describe("account-owned Kling model selection", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("includes a CLI profile without a key, and excludes it from image catalogs", () => {
    const providers = {
      "kling-cli": { enabled: true, apiKey: "", profileId: "profile-1" },
      openai: { enabled: true, apiKey: "" },
      "fal-ai": { enabled: true, apiKey: "real-key" },
    };
    expect(configuredCatalogProviders(providers, "video")).toEqual([
      { name: "kling-cli", profileId: "profile-1" },
      { name: "fal-ai", apiKey: "real-key", baseUrl: undefined },
    ]);
    expect(configuredCatalogProviders(providers, "image").map((provider) => provider.name)).toEqual(["fal-ai"]);
    expect(configuredCatalogProviders({ "kling-cli": { enabled: false, profileId: "profile-1" } })).toEqual([]);
  });

  it("keeps provider ownership when custom model IDs collide, and never permits custom CLI IDs", () => {
    const extras: CustomModel[] = [
      { id: "custom-1", modelId: "same-name", name: "Fal", provider: "fal-ai", mediaType: "video" },
      { id: "custom-2", modelId: "unguarded-id", name: "CLI", provider: "kling-cli", mediaType: "video" },
    ];
    const models = mergeCustomModels([{ id: "same-name", name: "Atlas", provider: "atlas-cloud" }], extras, "video");
    expect(models.map((model) => model.provider)).toEqual(["atlas-cloud", "fal-ai"]);
  });

  it("resolves the encoded tool and profile through protected catalog requests", async () => {
    const key = JSON.stringify(["kling-cli", "image_to_video", "model:with:separators"]);
    guardedFetch.mockResolvedValue(Response.json({ models: [{ id: key, provider: "kling-cli", name: "Model", mediaType: "video", extra: { profileId: "profile-1", selectionKey: key, tool: "image_to_video" } }] }));
    const target = await resolveDefaultModelTarget({ "kling-cli": { enabled: true, profileId: "profile-1" } }, key, [], "video");
    expect(target).toMatchObject({ provider: "kling-cli", apiKey: "", profileId: "profile-1", selectionKey: key, tool: "image_to_video", model: key });
    expect(JSON.parse(guardedFetch.mock.calls[0][1].body).providers).toEqual([{ name: "kling-cli", profileId: "profile-1" }]);
  });

  it("does not replace an unavailable CLI selection with a paid platform fallback", async () => {
    guardedFetch.mockResolvedValue(Response.json({ models: [{ id: "atlas-model", provider: "atlas-cloud", name: "Atlas" }] }));
    const target = await resolveDefaultModelTarget({ "kling-cli": { enabled: true } }, '["kling-cli","text_to_video","gone"]', [], "video");
    expect(target).toBeNull();
  });

  it("keeps the chosen Kling model despite a stale unsupported flag instead of switching platforms", async () => {
    const key = JSON.stringify(["kling-cli", "image_to_video", "disabled-model"]);
    guardedFetch.mockResolvedValue(Response.json({ models: [
      { id: key, provider: "kling-cli", name: "Disabled", extra: { available: false, disabledReason: "Account cannot submit this model" } },
      { id: "ark-model", provider: "volcengine", name: "Ark" },
    ] }));
    const target = await resolveDefaultModelTarget({ "kling-cli": { enabled: true }, volcengine: { enabled: true, apiKey: "test-key" } }, key, [], "video");
    expect(target).toMatchObject({ provider: "kling-cli", model: key, apiKey: "", selectionKey: key });
  });

  it("still respects unavailable descriptors from other providers", async () => {
    guardedFetch.mockResolvedValue(Response.json({ models: [{ id: "ark-model", provider: "volcengine", name: "Ark", extra: { available: false } }] }));
    const target = await resolveDefaultModelTarget({ "kling-cli": { enabled: true }, volcengine: { enabled: true, apiKey: "test-key" } }, "ark-model", [], "video");
    expect(target).toBeNull();
  });
});
