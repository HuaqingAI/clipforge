// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({
  db: null as unknown,
  generateTopicScript: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/script-engine/generator", () => ({
  generateTopicScript: state.generateTopicScript,
}));

import { POST } from "@/app/api/topic/script/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

const llmConfig = {
  provider: "test-provider",
  baseUrl: "https://llm.example.test/v1",
  apiKey: "test-key",
  model: "test-model",
};

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/topic/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.generateTopicScript.mockReset();
  state.generateTopicScript.mockResolvedValue([
    { title: "Topic script", styleType: "custom", totalDuration: 25, shots: [] },
  ]);
});

afterEach(() => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
});

describe("topic project creation creative profiles", () => {
  it("requires an explicit creation type before creating a topic project", async () => {
    const response = await POST(request({ topic: "A considered home design topic", llmConfig }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_PROFILE_REQUIRED",
      error: expect.stringContaining("creation type"),
    });
    expect(state.generateTopicScript).not.toHaveBeenCalled();
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
  });

  it("rejects an invalid or unsupported profile before generating a topic script", async () => {
    const invalid = await POST(request({
      topic: "A considered home design topic",
      creativeProfile: { creationType: "not-a-profile" },
      llmConfig,
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: expect.stringContaining("Unknown") });

    const premium = await POST(request({
      topic: "A considered home design topic",
      creativeProfile: { creationType: "premium_product_cg" },
      llmConfig,
    }));
    expect(premium.status).toBe(400);
    await expect(premium.json()).resolves.toMatchObject({ code: "TOPIC_CREATIVE_PROFILE_UNSUPPORTED" });
    expect(state.generateTopicScript).not.toHaveBeenCalled();
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
  });

  it("persists an explicit sales profile and its creation metadata for a new topic project", async () => {
    const response = await POST(request({
      topic: "A considered home design topic",
      targetDuration: 25,
      creativeProfile: {
        creationType: "short_video_sales",
        styleType: "story",
        videoMode: "scene_demo",
        targetDuration: 25,
      },
      llmConfig,
    }));

    expect(response.status).toBe(200);
    const project = db.select().from(schema.projects).get();
    expect(project).toMatchObject({
      contentType: "topic",
      topic: "A considered home design topic",
      videoMode: "scene_demo",
      creativeConfigRevision: 1,
      creativeProfile: {
        creationType: "short_video_sales",
        styleType: "story",
        videoMode: "scene_demo",
        targetDuration: 25,
      },
      creativeProfileDrafts: {
        short_video_sales: {
          creationType: "short_video_sales",
          styleType: "story",
          videoMode: "scene_demo",
        },
        premium_product_cg: { creationType: "premium_product_cg" },
      },
    });
    expect(state.generateTopicScript).toHaveBeenCalledOnce();
  });
});
