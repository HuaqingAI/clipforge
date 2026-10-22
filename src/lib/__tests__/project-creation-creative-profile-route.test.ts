// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@/lib/db/schema";

const state = vi.hoisted(() => ({
  db: null as unknown,
  safeFetch: vi.fn(),
  uploadsDir: "",
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/ssrf-guard", () => ({ safeFetch: state.safeFetch }));
vi.mock("@/lib/paths", () => ({ getUploadsDir: () => state.uploadsDir }));

import { POST as createProject } from "@/app/api/project/route";
import { POST as ingestProduct } from "@/app/api/ingest/product/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let uploadsDir = "";

function request(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function productHtmlResponse() {
  return new Response("<html><head><title>Reference Chair</title></head><body></body></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  uploadsDir = mkdtempSync(join(tmpdir(), "clipforge-project-create-"));
  state.uploadsDir = uploadsDir;
  state.safeFetch.mockReset();
});

afterEach(() => {
  sqlite.close();
  rmSync(uploadsDir, { recursive: true, force: true });
  state.db = null;
  state.uploadsDir = "";
  vi.clearAllMocks();
});

describe("project creation requires an explicit creative profile", () => {
  it("rejects a direct project create without a creation type", async () => {
    const response = await createProject(request("http://localhost/api/project", { name: "Missing profile" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREATIVE_PROFILE_REQUIRED",
      error: expect.stringContaining("creation type"),
    });
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
  });

  it("accepts and persists an explicit short-video sales creation type", async () => {
    const response = await createProject(request("http://localhost/api/project", {
      name: "Explicit sales profile",
      creativeProfile: {
        creationType: "short_video_sales",
        styleType: "scene",
        videoMode: "scene_demo",
        targetDuration: 45,
      },
    }));

    expect(response.status).toBe(201);
    const project = await response.json();
    expect(project.creativeProfile).toMatchObject({
      creationType: "short_video_sales",
      styleType: "scene",
      videoMode: "scene_demo",
      targetDuration: 45,
    });
    expect(project.creativeProfileDrafts.short_video_sales).toMatchObject({
      creationType: "short_video_sales",
      styleType: "scene",
    });
  });

  it("rejects a project-producing link import before fetching when no type was chosen", async () => {
    const response = await ingestProduct(request("http://localhost/api/ingest/product", {
      url: "https://example.test/products/chair",
      createProject: true,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "CREATIVE_PROFILE_REQUIRED" });
    expect(state.safeFetch).not.toHaveBeenCalled();
  });

  it("keeps analysis-only link imports available without a creation type", async () => {
    state.safeFetch.mockResolvedValue(productHtmlResponse());

    const response = await ingestProduct(request("http://localhost/api/ingest/product", {
      url: "https://example.test/products/chair",
      createProject: false,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      product: { title: "Reference Chair" },
    });
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
  });
});
