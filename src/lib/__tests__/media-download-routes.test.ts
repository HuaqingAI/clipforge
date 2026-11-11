// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory }));

import { GET as getUploadedFile } from "@/app/api/files/[...path]/route";
import { GET as getOutputFile } from "@/app/api/output/[...path]/route";

const video = Buffer.from("downloaded video bytes");
const names = ["take.mp4", "户外成片 (终版)'1.mp4"];

beforeAll(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-media-download-"));
  for (const root of ["uploads", "output"]) {
    await mkdir(join(state.directory, root, "project"), { recursive: true });
    for (const name of names) await writeFile(join(state.directory, root, "project", name), video);
  }
});
afterAll(async () => { await rm(state.directory, { recursive: true, force: true }); });

describe.each([
  { endpoint: "files", get: getUploadedFile },
  { endpoint: "output", get: getOutputFile },
])("$endpoint media downloads", ({ endpoint, get }) => {
  function request(name: string, download = false, range?: string) {
    return get(new NextRequest(`http://localhost/api/${endpoint}/project/${encodeURIComponent(name)}${download ? "?download=1" : ""}`, {
      headers: range ? { range } : undefined,
    }), { params: Promise.resolve({ path: ["project", name] }) });
  }

  it("keeps ordinary playback inline and supports video seeking", async () => {
    const response = await request(names[0], false, "bytes=2-7");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe(`bytes 2-7/${video.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(2, 8));
  });

  it.each(names)("downloads the complete file with its original name: %s", async (name) => {
    const response = await request(name, true);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(name);
    expect(response.headers.get("content-length")).toBe(String(video.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(video);
  });

  it("keeps the attachment header and correct bytes when resuming a download", async () => {
    const response = await request(names[0], true, "bytes=8-");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(video.length - 8));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(video.subarray(8));
  });
});
