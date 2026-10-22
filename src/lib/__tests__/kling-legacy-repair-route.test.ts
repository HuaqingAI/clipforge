// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/project/[id]/repair/route";

const io = vi.hoisted(() => ({ getDb: vi.fn(), createProvider: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: io.getDb }));
vi.mock("@/lib/providers", () => ({ createProvider: io.createProvider }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));

describe("Kling cannot enter automatic repair", () => {
  it.each([
    { provider: "kling-cli", model: "official" },
    { provider: "atlas-cloud", model: JSON.stringify(["kling-cli", "image_to_video", "official"]) },
  ])("blocks preview and execution before media or provider access: %o", async (target) => {
    for (const action of ["preview", "execute"]) {
      const response = await POST(new NextRequest("http://localhost/api/project/project-1/repair", { method: "POST", body: JSON.stringify({ action, assetId: "asset-1", reviewId: "review-1", ...target }) }), { params: Promise.resolve({ id: "project-1" }) });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("KLING_SCOPE_UNSUPPORTED");
    }
    expect(io.getDb).not.toHaveBeenCalled();
    expect(io.createProvider).not.toHaveBeenCalled();
  });
});
