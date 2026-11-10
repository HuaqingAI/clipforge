// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createProvider, getAvailableProviders } from "@/lib/providers";

describe("active generation providers", () => {
  it.each(["volcengine", "alibaba", "siliconflow"])("hides retired provider %s while preserving its historical task adapter", name => {
    expect(getAvailableProviders().some(provider => provider.name === name)).toBe(false);
    const historical = createProvider({ name, apiKey: "historical-key", baseUrl: "https://custom.example/v1" });
    expect(historical.name).toBe(name);
    expect(historical.getTaskStatus).toBeTypeOf("function");
  });

  it("offers HTH under its persisted openai key alongside the remaining providers", () => {
    expect(getAvailableProviders().find(provider => provider.name === "openai")).toMatchObject({ displayName: "HTH" });
    expect(getAvailableProviders().map(provider => provider.name)).toEqual(["atlas-cloud", "fal-ai", "replicate", "openai", "kling-cli"]);
    expect(createProvider({ name: "openai", apiKey: "key", baseUrl: "" })).toMatchObject({ name: "openai", displayName: "HTH" });
  });
});
