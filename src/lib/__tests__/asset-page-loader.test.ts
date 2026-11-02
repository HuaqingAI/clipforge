import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_PAGE_REQUEST_TIMEOUT_MS,
  ASSET_PAGE_RETRY_DELAY_MS,
  createAssetPageLoader,
} from "@/lib/asset-page-loader";

const fetchMock = vi.fn<typeof fetch>();
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const dataFor = (url: string) => url.endsWith("/scripts")
  ? [{ id: "script-a", selected: true, shots: [] }]
  : url.endsWith("/assets") ? [] : { name: url };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (url) => reply(dataFor(String(url))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("asset page loader", () => {
  it("coalesces concurrent page and task refreshes and releases the completed load", async () => {
    const projectBody = deferred<unknown>();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: () => projectBody.promise }) as Response);
    const loader = createAssetPageLoader();
    const first = loader.load("project-a");
    const second = loader.load("project-a");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    projectBody.resolve({ name: "Project A" });
    await expect(first).resolves.toMatchObject({ project: { name: "Project A" }, savedAssets: [] });
    await loader.load("project-a");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled response bodies as well as fetch, with just one automatic retry", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(async (_url, options) => {
      signals.push(options!.signal!);
      return { ok: true, json: () => new Promise(() => {}) } as Response;
    });
    const promise = createAssetPageLoader().load("project-a");
    const rejected = expect(promise).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(ASSET_PAGE_REQUEST_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(ASSET_PAGE_RETRY_DELAY_MS + ASSET_PAGE_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates a cancelled project from the next project even when the old body resolves late", async () => {
    const projectBody = deferred<unknown>();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: () => projectBody.promise }) as Response);
    const loader = createAssetPageLoader();
    const old = loader.load("project-a");
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const current = loader.load("project-b");
    await rejected;
    projectBody.resolve({ name: "Stale project" });
    await expect(current).resolves.toMatchObject({ project: { name: "/api/project/project-b" } });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels on unmount and allows a fresh load immediately", async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const loader = createAssetPageLoader();
    const old = loader.load("project-a");
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    loader.cancel();
    await expect(loader.load("project-a")).resolves.toHaveProperty("savedAssets");
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a caller AbortSignal without retrying cancelled requests", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = createAssetPageLoader().load("project-a", { signal: controller.signal });
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(ASSET_PAGE_REQUEST_TIMEOUT_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 500, 503])("retries HTTP %i once, then returns fresh data", async (status) => {
    fetchMock.mockResolvedValueOnce(reply({ error: "Temporary failure" }, status));
    const promise = createAssetPageLoader().load("project-a");
    await vi.advanceTimersByTimeAsync(ASSET_PAGE_RETRY_DELAY_MS);
    await expect(promise).resolves.toHaveProperty("savedAssets");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("retries a transport failure once", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network error"));
    const promise = createAssetPageLoader().load("project-a");
    await vi.advanceTimersByTimeAsync(ASSET_PAGE_RETRY_DELAY_MS);
    await expect(promise).resolves.toHaveProperty("savedAssets");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([400, 401, 404, 409])("surfaces HTTP %i without retry or a false no-script result", async (status) => {
    fetchMock.mockResolvedValueOnce(reply({ error: "Request failed" }, status));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "response", status });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry invalid JSON or a successful response containing an error object", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{broken JSON", { status: 200 }));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    fetchMock.mockResolvedValueOnce(reply({ error: "Unexpected API error" }));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates script and asset arrays before returning a snapshot", async () => {
    fetchMock.mockImplementation(async (url) => reply(String(url).endsWith("/scripts") ? { error: "Unavailable" } : dataFor(String(url))));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    fetchMock.mockImplementation(async (url) => reply(String(url).endsWith("/assets") ? null : dataFor(String(url))));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([{}, { shotId: "1" }, { shotId: null }])("rejects an asset row without a numeric shot ID: %j", async (row) => {
    fetchMock.mockImplementation(async (url) => reply(String(url).endsWith("/assets") ? [row] : dataFor(String(url))));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed script rows before treating their shots as selected", async () => {
    fetchMock.mockImplementation(async (url) => reply(String(url).endsWith("/scripts")
      ? [{ selected: true, shots: [{ description: "Missing shot ID" }] }] : dataFor(String(url))));
    await expect(createAssetPageLoader().load("project-a")).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
