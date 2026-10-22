// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  createPremiumProductCgProfile,
  createShortVideoSalesProfile,
} from "@/lib/creative-profiles";

const state = vi.hoisted(() => ({
  db: null as unknown,
  generateCarousel: vi.fn(),
  generateEndCard: vi.fn(),
  generateShopQr: vi.fn(),
  applyNativeFeel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/video-composer/carousel", () => ({ generateCarousel: state.generateCarousel }));
vi.mock("@/lib/video-composer/end-card", () => ({ generateEndCard: state.generateEndCard }));
vi.mock("@/lib/shop-qr", () => ({ generateShopQr: state.generateShopQr }));
vi.mock("@/lib/video-composer/composer", () => ({ resolveChineseFontFile: vi.fn().mockReturnValue(undefined) }));
vi.mock("@/lib/video-composer/native-feel", () => ({ applyNativeFeel: state.applyNativeFeel }));

import { POST as carouselPost } from "@/app/api/project/[id]/carousel/route";
import { POST as endCardPost } from "@/app/api/project/[id]/end-card/route";
import { POST as shopQrPost } from "@/app/api/project/[id]/shop-qr/route";
import { GET as subtitleGet } from "@/app/api/project/[id]/subtitle/route";
import { POST as nativeFeelPost } from "@/app/api/project/[id]/native-feel/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let directory: string;

function postRequest(projectId: string, suffix: string, body: Record<string, unknown> = {}) {
  return new NextRequest(`http://localhost/api/project/${projectId}/${suffix}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clipforge-premium-output-policy-"));
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.generateCarousel.mockReset().mockResolvedValue([join(directory, "carousel.png")]);
  state.generateEndCard.mockReset().mockResolvedValue(undefined);
  state.generateShopQr.mockReset().mockResolvedValue("https://shop.example.test/product?utm_source=clipforge");
  state.applyNativeFeel.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("premium CG direct output policy", () => {
  it("blocks text, subtitle, and commerce outputs from the persisted premium profile", async () => {
    const projectId = "premium-output-project";
    db.insert(schema.projects).values({
      id: projectId,
      name: "Premium output policy",
      shopUrl: "https://shop.example.test/product",
      creativeProfile: createPremiumProductCgProfile({ brandEndCard: "approved" }),
    }).run();

    const responses = await Promise.all([
      carouselPost(postRequest(projectId, "carousel"), params(projectId)),
      endCardPost(postRequest(projectId, "end-card"), params(projectId)),
      shopQrPost(postRequest(projectId, "shop-qr"), params(projectId)),
      subtitleGet(new NextRequest(`http://localhost/api/project/${projectId}/subtitle?format=srt`), params(projectId)),
      nativeFeelPost(postRequest(projectId, "native-feel"), params(projectId)),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_OUTPUT_POLICY" });
    }
    expect(state.generateCarousel).not.toHaveBeenCalled();
    expect(state.generateShopQr).not.toHaveBeenCalled();
    expect(state.generateEndCard).not.toHaveBeenCalled();
    expect(state.applyNativeFeel).not.toHaveBeenCalled();
  });

  it("keeps legacy sales project output routes available", async () => {
    const projectId = "sales-output-project";
    const outputPath = join(directory, "sales-composition.mp4");
    writeFileSync(outputPath, "video");
    db.insert(schema.projects).values({
      id: projectId,
      name: "Sales output policy",
      shopUrl: "https://shop.example.test/product",
      creativeProfile: createShortVideoSalesProfile({ styleType: "scene" }),
    }).run();
    db.insert(schema.scripts).values({
      id: "sales-output-script",
      projectId,
      selected: true,
      styleType: "scene",
      title: "Sales title",
      shots: [{
        shotId: 1,
        type: "product_reveal",
        duration: 4,
        description: "A chair in a bright room.",
        camera: "Slow push-in.",
        voiceover: "Discover the chair details.",
        visualSource: "product_image",
        transition: "direct_concat",
      }],
    }).run();
    db.insert(schema.compositions).values({
      id: "sales-composition",
      projectId,
      outputPath,
      status: "done",
    }).run();

    const carousel = await carouselPost(postRequest(projectId, "carousel"), params(projectId));
    expect(carousel.status).toBe(200);
    await expect(carousel.json()).resolves.toMatchObject({ count: 1, cards: [expect.stringContaining("carousel.png")] });

    const subtitles = await subtitleGet(
      new NextRequest(`http://localhost/api/project/${projectId}/subtitle?format=srt`),
      params(projectId),
    );
    expect(subtitles.status).toBe(200);
    await expect(subtitles.text()).resolves.toContain("Discover the chair details.");

    const qr = await shopQrPost(postRequest(projectId, "shop-qr"), params(projectId));
    expect(qr.status).toBe(200);
    await expect(qr.json()).resolves.toMatchObject({ qr: expect.stringContaining("shop-qr-") });

    const endCard = await endCardPost(postRequest(projectId, "end-card"), params(projectId));
    expect(endCard.status).toBe(200);
    await expect(endCard.json()).resolves.toMatchObject({ video: expect.stringContaining("endcard-") });
    expect(state.generateCarousel).toHaveBeenCalledTimes(1);
    expect(state.generateShopQr).toHaveBeenCalledTimes(2);
    expect(state.generateEndCard).toHaveBeenCalledTimes(1);
  });
});
