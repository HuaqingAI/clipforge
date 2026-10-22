// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type { KlingProfile } from "@/lib/kling/types";
import type { KlingJobData } from "@/lib/kling/job-schema";

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));
vi.mock("@/lib/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  state.sqlite = new Database(":memory:");
  const db = drizzle(state.sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db, getDb: () => db };
});

import { db } from "@/lib/db";
import { klingProfiles } from "@/lib/kling/profile-schema";
import { klingJobs } from "@/lib/kling/job-schema";
import { getPublicKlingStatus } from "@/lib/kling/profiles";

const first = randomUUID(), second = randomUUID(), other = randomUUID();
function profile(id: string, principalKey = "same-account"): KlingProfile {
  return { id, principalKey, label: "Fixture", region: "global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", adapterVersion: "1", nodePath: "/node", packagePath: "/cli", cliEntry: "/cli.js", homePath: "/private-credentials", endpoint: "https://kling.ai/mcp", environmentState: "ready", authState: "authenticated", authRevision: 1, catalogSnapshot: [], createdAt: 1, updatedAt: 1 };
}
function job(profileId: string, patch: Partial<typeof klingJobs.$inferInsert> = {}) {
  const owner = profileId === other ? "other-account" : "same-account";
  db.insert(klingJobs).values({ id: randomUUID(), profileId, principalKey: owner, region: "global", projectId: randomUUID(), scriptId: randomUUID(), clientRequestId: randomUUID(), shotId: 1,
    submissionState: "acknowledged", remoteState: "processing", data: {} as KlingJobData, createdAt: 1, updatedAt: 1, ...patch }).run();
}

beforeEach(() => {
  state.sqlite!.exec("DELETE FROM kling_jobs; DELETE FROM kling_profiles;");
  for (const id of [first, second, other]) db.insert(klingProfiles).values({ id, data: profile(id, id === other ? "other-account" : "same-account") }).run();
});
afterAll(() => state.sqlite?.close());

describe("Kling account capacity status", () => {
  it("counts reservations and cloud jobs across projects and profiles of the same account", () => {
    job(first, { submissionState: "prepared", remoteState: "not_started" });
    job(second, { submissionState: "submitting", remoteState: "not_started" });
    job(second);
    job(other);
    expect(getPublicKlingStatus(first).concurrency).toEqual({ active: 3, max: 10, blockedByUnknownSubmission: false });
    expect(getPublicKlingStatus(second).concurrency?.active).toBe(3);
    expect(getPublicKlingStatus(other).concurrency?.active).toBe(1);
  });
  it("releases cloud generation capacity even when local import still needs recovery", () => {
    job(first, { remoteState: "completed", importState: "failed" });
    job(first, { remoteState: "failed" });
    job(first, { remoteState: "cancelled" });
    job(first, { submissionState: "not_submitted", remoteState: "not_started" });
    expect(getPublicKlingStatus(first).concurrency).toEqual({ active: 0, max: 10, blockedByUnknownSubmission: false });
  });
  it("exposes an unknown-submission block without leaking other projects or task IDs", () => {
    job(second, { id: "private-job", projectId: "private-project", submissionState: "submission_unknown", remoteState: "unknown" });
    const status = getPublicKlingStatus(first);
    expect(status.concurrency).toEqual({ active: 1, max: 10, blockedByUnknownSubmission: true });
    expect(JSON.stringify(status)).not.toMatch(/private-job|private-project|private-credentials/);
    expect(getPublicKlingStatus(other).concurrency?.blockedByUnknownSubmission).toBe(false);
  });
  it("ignores deleted cloud jobs and unknown submissions in account capacity", () => {
    const deleted = { deletedAt: Date.now() } as KlingJobData;
    job(first, { data: deleted });
    job(second, { submissionState: "submission_unknown", remoteState: "unknown", data: deleted });
    job(first, { submissionState: "submitting", remoteState: "not_started", data: deleted });
    job(second);
    expect(getPublicKlingStatus(first).concurrency).toEqual({ active: 1, max: 10, blockedByUnknownSubmission: false });
    expect(getPublicKlingStatus(second).concurrency).toEqual({ active: 1, max: 10, blockedByUnknownSubmission: false });
  });
});
