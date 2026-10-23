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
import { createPremiumProductCgProfile, createShortVideoSalesProfile, type ProjectCreativeProfileDrafts } from "@/lib/creative-profiles";

const state = vi.hoisted(() => ({
  db: null as unknown,
  safeFetch: vi.fn(),
  uploadsDir: "",
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/ssrf-guard", () => ({ safeFetch: state.safeFetch }));
vi.mock("@/lib/paths", () => ({ getUploadsDir: () => state.uploadsDir }));
vi.mock("@/lib/kling/repository", () => ({ listKlingJobs: vi.fn(), isKlingJobUnresolved: vi.fn() }));
vi.mock("@/lib/kling/film-repository", () => ({ listKlingFilms: vi.fn(), isKlingFilmUnresolved: vi.fn() }));

import { POST as createProject } from "@/app/api/project/route";
import { POST as ingestProduct } from "@/app/api/ingest/product/route";
import { PATCH as patchProject } from "@/app/api/project/[id]/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let uploadsDir = "";

function request(url: string, body: Record<string, unknown>, method = "POST") {
  return new NextRequest(url, {
    method,
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
  it.each(["create", "ingest"] as const)("rejects invalid draft sources in %s requests before writing or fetching", async (route) => {
    const body = {
      name: "Invalid nested source",
      url: "https://example.test/products/chair",
      creativeProfile: { creationType: "short_video_sales" },
      creativeProfileDrafts: {
        premium_product_cg: { creationType: "premium_product_cg", visualSource: "user_upload" },
      },
    };
    const response = route === "create"
      ? await createProject(request("http://localhost/api/project", body))
      : await ingestProduct(request("http://localhost/api/ingest/product", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("visualSource");
    expect(db.select().from(schema.projects).all()).toHaveLength(0);
    expect(state.safeFetch).not.toHaveBeenCalled();
  });

  it.each(["create", "ingest"] as const)("preserves a valid inactive AI draft in %s requests", async (route) => {
    state.safeFetch.mockResolvedValue(productHtmlResponse());
    const body = {
      name: "Saved AI draft",
      url: "https://example.test/products/chair",
      creativeProfile: createShortVideoSalesProfile(),
      creativeProfileDrafts: { cg: createPremiumProductCgProfile({ visualSource: "ai_generate" }) },
    };
    const response = route === "create"
      ? await createProject(request("http://localhost/api/project", body))
      : await ingestProduct(request("http://localhost/api/ingest/product", body));
    expect(response.status).toBe(route === "create" ? 201 : 200);
    const stored = db.select().from(schema.projects).all()[0];
    expect(stored.creativeProfile?.visualSource).toBe("product_image");
    expect(stored.creativeProfileDrafts?.premium_product_cg?.visualSource).toBe("ai_generate");
  });

  it("preserves top-level visual source compatibility on product-link imports", async () => {
    state.safeFetch.mockResolvedValue(productHtmlResponse());
    const response = await ingestProduct(request("http://localhost/api/ingest/product", {
      url: "https://example.test/products/chair",
      creationType: "premium_product_cg",
      visualSource: "ai_generate",
    }));
    expect(response.status).toBe(200);
    const stored = db.select().from(schema.projects).all()[0];
    expect(stored.creativeProfile?.visualSource).toBe("ai_generate");
    expect(stored.creativeProfileDrafts?.premium_product_cg?.visualSource).toBe("ai_generate");
    expect(stored.creativeProfileDrafts?.short_video_sales?.visualSource).toBe("ai_generate");
  });

  it("rejects an unsupported top-level visual source on imports before fetching", async () => {
    const response = await ingestProduct(request("http://localhost/api/ingest/product", {
      url: "https://example.test/products/chair",
      creationType: "premium_product_cg",
      visualSource: "user_upload",
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("visualSource");
    expect(state.safeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["short_video_sales", "product_image"],
    ["short_video_sales", "ai_generate"],
    ["premium_product_cg", "product_image"],
    ["premium_product_cg", "ai_generate"],
  ])("persists the %s visual source %s in the active profile and draft", async (creationType, visualSource) => {
    const response = await createProject(request("http://localhost/api/project", {
      name: "Chosen product source",
      creativeProfile: { creationType, visualSource },
    }));
    expect(response.status).toBe(201);
    const project = await response.json();
    expect(project.creativeProfile.visualSource).toBe(visualSource);
    expect(project.creativeProfileDrafts[creationType].visualSource).toBe(visualSource);
    const stored = db.select().from(schema.projects).all()[0];
    expect(stored.creativeProfile?.visualSource).toBe(visualSource);
  });

  it("defaults new projects to originals and rejects an unsupported explicit source", async () => {
    const response = await createProject(request("http://localhost/api/project", {
      name: "Default source", creativeProfile: { creationType: "premium_product_cg" },
    }));
    expect(response.status).toBe(201);
    expect((await response.json()).creativeProfile.visualSource).toBe("product_image");
    const invalid = await createProject(request("http://localhost/api/project", {
      name: "Invalid source", creativeProfile: { creationType: "premium_product_cg", visualSource: "user_upload" },
    }));
    expect(invalid.status).toBe(400);
    expect(db.select().from(schema.projects).all()).toHaveLength(1);
  });

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

describe("project draft updates validate new input while preserving legacy reads", () => {
  async function originalProject() {
    const response = await createProject(request("http://localhost/api/project", {
      name: "Draft source update", creativeProfile: createShortVideoSalesProfile(),
    }));
    return response.json();
  }

  it("rejects a draft-only source update that would silently reset to the default", async () => {
    const project = await originalProject();
    const response = await patchProject(request(`http://localhost/api/project/${project.id}`, {
      expectedCreativeConfigRevision: project.creativeConfigRevision,
      creativeProfileDrafts: { sales: { creationType: "short_video_sales", visualSource: "user_upload" } },
    }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("visualSource");
    expect(db.select().from(schema.projects).all()[0].creativeConfigRevision).toBe(project.creativeConfigRevision);
  });

  it("applies a valid AI source from a draft-only update and increments the profile revision", async () => {
    const project = await originalProject();
    const response = await patchProject(request(`http://localhost/api/project/${project.id}`, {
      expectedCreativeConfigRevision: project.creativeConfigRevision,
      creativeProfileDrafts: { sales: createShortVideoSalesProfile({ visualSource: "ai_generate" }) },
    }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      creativeProfile: { visualSource: "ai_generate" },
      creativeProfileDrafts: { short_video_sales: { visualSource: "ai_generate" } },
      creativeConfigRevision: project.creativeConfigRevision + 1,
    });
  });

  it("continues to canonicalize pre-existing draft data when only valid new input is submitted", async () => {
    const project = await originalProject();
    db.update(schema.projects).set({
      creativeProfileDrafts: {
        premium_product_cg: { creationType: "premium_product_cg", visualSource: "user_upload" },
      } as unknown as ProjectCreativeProfileDrafts,
    }).run();
    const response = await patchProject(request(`http://localhost/api/project/${project.id}`, {
      expectedCreativeConfigRevision: project.creativeConfigRevision,
      creativeProfile: createShortVideoSalesProfile({ visualSource: "ai_generate" }),
    }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      creativeProfile: { visualSource: "ai_generate" },
      creativeProfileDrafts: { premium_product_cg: { visualSource: "product_image" } },
    });
  });
});
