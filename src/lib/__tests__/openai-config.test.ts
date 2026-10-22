import { describe, expect, it } from "vitest";
import { normalizeOpenAIBaseUrl, OPENAI_BASE_URL } from "@/lib/openai-config";

describe("OpenAI image API bases", () => {
  it.each([undefined, "", "   "])("uses the official default for %j", (base) => {
    expect(normalizeOpenAIBaseUrl(base)).toBe(OPENAI_BASE_URL);
  });

  it.each(["https://hth.huaqing.run", " https://hth.huaqing.run/// ", "https://hth.huaqing.run/v1/"])(
    "uses the verified HTH API path for %s", (base) => {
      expect(normalizeOpenAIBaseUrl(base)).toBe("https://hth.huaqing.run/v1");
    },
  );

  it.each(["edits", "generations"])("accepts a full image %s endpoint with a custom gateway prefix", (operation) => {
    expect(normalizeOpenAIBaseUrl(` https://gateway.example/api/v1/images/${operation}/// `))
      .toBe("https://gateway.example/api/v1");
  });

  it("normalizes the official root without changing arbitrary custom API paths", () => {
    expect(normalizeOpenAIBaseUrl("https://api.openai.com/")).toBe(OPENAI_BASE_URL);
    expect(normalizeOpenAIBaseUrl("https://custom.example/")).toBe("https://custom.example");
    expect(normalizeOpenAIBaseUrl("https://custom.example/api/image-proxy///")).toBe("https://custom.example/api/image-proxy");
    expect(normalizeOpenAIBaseUrl("https://hth.huaqing.run/custom/v2/")).toBe("https://hth.huaqing.run/custom/v2");
  });
});
