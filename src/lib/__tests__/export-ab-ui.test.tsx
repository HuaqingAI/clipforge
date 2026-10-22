import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExportPage from "@/app/project/[id]/export/page";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "project-1" }) }));
vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key, useLocale: () => "zh" }));
vi.mock("@/components/project-header", () => ({ ProjectHeader: () => null }));
vi.mock("@/components/performance-feedback", () => ({ PerformanceFeedback: () => null }));
vi.mock("@/components/platform-export-panel", () => ({ PlatformExportPanel: () => null }));
vi.mock("@/lib/stores/settings-store", () => ({ useSettingsStore: () => ({ llm: { apiKey: "" } }) }));

const fetchMock = vi.fn();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/project/project-1") return Response.json({ name: "Test project" });
    if (url.endsWith("/compositions")) return Response.json({ compositions: [{ id: "composition-1", url: "/output/video.mp4", fileName: "video.mp4", resolution: "1080p", aspectRatio: "9:16", status: "done" }] });
    if (url.endsWith("/scripts")) return Response.json([]);
    if (init?.method === "HEAD") return new Response(null);
    // End each variant immediately so both request bodies can be checked without polling.
    if (url.endsWith("/compose") && init?.method === "POST") return Response.json({ error: "Test response" }, { status: 400 });
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("export A/B captions", () => {
  it("renders both subtitle variants without requesting automatic music", async () => {
    await act(async () => root.render(<ExportPage />));
    const generate = [...container.querySelectorAll("button")].find((button) => button.textContent === "abGenerate")!;
    expect(generate).toBeDefined();
    await act(async () => generate.click());
    const requests = fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/project/project-1/compose" && init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body));
    expect(requests).toHaveLength(2);
    expect(requests.map((body) => body.karaoke)).toEqual([true, false]);
    for (const body of requests) {
      expect(body.freeTts).toEqual({ enabled: true });
      expect(body).not.toHaveProperty("freeBgm");
      expect(body).not.toHaveProperty("bgmMood");
    }
    expect(container.textContent).toContain("abVariantKaraoke");
    expect(container.textContent).toContain("abVariantRapid");
  });
});
