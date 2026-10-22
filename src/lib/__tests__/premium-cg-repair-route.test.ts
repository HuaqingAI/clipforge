// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createPremiumProductCgProfile } from "@/lib/creative-profiles";

const state = vi.hoisted(() => ({
  db: null as unknown,
  createProvider: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/providers", () => ({ createProvider: state.createProvider }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: vi.fn(), updateAiTask: vi.fn() }));

import { POST } from "@/app/api/project/[id]/repair/route";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clipforge-premium-repair-policy-"));
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  state.db = db;
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  state.createProvider.mockReset();
});

afterEach(() => {
  sqlite.close();
  state.db = null;
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("premium CG repair policy", () => {
  it("rejects generic video repair before inspecting assets or submitting a provider task", async () => {
    const projectId = "premium-repair-project";
    db.insert(schema.projects).values({
      id: projectId,
      name: "Premium repair policy",
      creativeProfile: createPremiumProductCgProfile(),
    }).run();

    const response = await POST(
      new NextRequest(`http://localhost/api/project/${projectId}/repair`, {
        method: "POST",
        body: JSON.stringify({
          action: "preview",
          assetId: "asset-1",
          reviewId: "review-1",
          provider: "atlas-cloud",
          model: "doubao-seedance-2.5",
        }),
      }),
      { params: Promise.resolve({ id: projectId }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "PREMIUM_CG_OUTPUT_POLICY" });
    expect(state.createProvider).not.toHaveBeenCalled();
  });
});
