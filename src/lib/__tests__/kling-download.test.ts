// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, RequestOptions } from "node:http";
import { downloadPublicFile, isPublicAddress, publicDownloadResponse } from "@/lib/kling/download";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), responses: [] as IncomingMessage[] }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));
vi.mock("node:http", () => ({ request: network.request }));
let directory = "";
function response(chunks: Buffer[] = [], headers: Record<string, string> = {}, status = 200): IncomingMessage {
  return Object.assign(Readable.from(chunks), { statusCode: status, headers }) as IncomingMessage;
}
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "clipforge-kling-download-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
beforeEach(() => {
  network.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  network.request.mockReset(); network.responses = [];
  network.request.mockImplementation((_url: URL, _options: RequestOptions, onResponse: (value: IncomingMessage) => void) => {
    const req = Object.assign(new EventEmitter(), { end: () => onResponse(network.responses.shift() ?? response()), destroy: vi.fn() });
    return req;
  });
});

describe("bounded public Kling downloads", () => {
  it.each(["0.0.0.0", "10.0.0.1", "127.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.1.2", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"])("rejects local/reserved address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each(["2001::1", "2001:0000::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:01ff::1", "2002:7f00:1::", "3ffe::1", "3fff::1", "3fff:0fff::1"])("rejects transitional and reserved IPv6 spellings %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("rejects non-HTTP or credential-bearing URLs before DNS or network requests", async () => {
    await expect(publicDownloadResponse("file:///C:/private")).rejects.toMatchObject({ code: "KLING_DOWNLOAD_FAILED" });
    await expect(publicDownloadResponse("https://user:pass@example.com/video.mp4")).rejects.toMatchObject({ code: "KLING_DOWNLOAD_FAILED" });
    expect(network.lookup).not.toHaveBeenCalled(); expect(network.request).not.toHaveBeenCalled();
  });
  it("pins the checked DNS address into the actual HTTP connection", async () => {
    network.responses.push(response());
    await publicDownloadResponse("https://cdn.example/video.mp4");
    const options = network.request.mock.calls[0][1] as RequestOptions;
    const callback = vi.fn();
    options.lookup!("cdn.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(network.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects a hostname if even one resolved address is private", async () => {
    network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(publicDownloadResponse("https://cdn.example/video.mp4")).rejects.toMatchObject({ code: "KLING_DOWNLOAD_ADDRESS_BLOCKED" });
    expect(network.request).not.toHaveBeenCalled();
  });
  it("checks each redirect instead of following a public URL into metadata services", async () => {
    network.responses.push(response([], { location: "http://169.254.169.254/latest/meta-data" }, 302));
    await expect(publicDownloadResponse("https://cdn.example/video.mp4")).rejects.toMatchObject({ code: "KLING_DOWNLOAD_ADDRESS_BLOCKED" });
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it("stops redirect loops", async () => {
    network.responses = Array.from({ length: 6 }, () => response([], { location: "/again" }, 302));
    await expect(publicDownloadResponse("https://cdn.example/again")).rejects.toMatchObject({ code: "KLING_DOWNLOAD_FAILED" });
    expect(network.request).toHaveBeenCalledTimes(6);
  });
  it("enforces both declared and streamed byte limits", async () => {
    network.responses.push(response([Buffer.from("too long")], { "content-length": "1000" }));
    await expect(downloadPublicFile("https://cdn.example/a", join(directory, "declared.part"), 4)).rejects.toMatchObject({ code: "KLING_DOWNLOAD_TOO_LARGE" });
    network.responses.push(response([Buffer.from("123"), Buffer.from("456")]));
    await expect(downloadPublicFile("https://cdn.example/b", join(directory, "streamed.part"), 4)).rejects.toMatchObject({ code: "KLING_DOWNLOAD_TOO_LARGE" });
  });
  it("streams a bounded result to disk and rejects empty output", async () => {
    network.responses.push(response([Buffer.from("123"), Buffer.from("456")]));
    const file = join(directory, "valid.part");
    expect(await downloadPublicFile("https://cdn.example/video", file, 6)).toBe(6);
    expect(await readFile(file, "utf8")).toBe("123456");
    network.responses.push(response());
    await expect(downloadPublicFile("https://cdn.example/empty", join(directory, "empty.part"), 6)).rejects.toMatchObject({ code: "KLING_MEDIA_INVALID" });
  });
});
