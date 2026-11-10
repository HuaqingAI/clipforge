// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asrRuntimeDescriptor, resolveAsrAsset } from "@/lib/asr-runtime";
import { GET } from "@/app/api/runtime/asr/[...path]/route";

let directory: string;
const model = "onnx-community/whisper-tiny_timestamped";
async function fixture(file: string, data = "fixture") {
  const filename = join(directory, file);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, data);
  return filename;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clipforge-asr-runtime-"));
  vi.stubEnv("CLIPFORGE_RUNTIME", "desktop");
  vi.stubEnv("CLIPFORGE_DESKTOP_LOCAL", "1");
  vi.stubEnv("APP_ASR_MODEL_DIR", directory);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("installed ASR resource serving", () => {
  it("advertises only complete models with both GPU and WASM fallback weights", async () => {
    for (const file of ["config.json", "tokenizer.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/encoder_model_quantized.onnx"]) await fixture(`${model}/${file}`);
    expect(asrRuntimeDescriptor().models).toEqual([]);
    await fixture(`${model}/onnx/decoder_model_merged_quantized.onnx`);
    expect(asrRuntimeDescriptor()).toMatchObject({ mode: "managed", models: [model] });
    vi.stubEnv("CLIPFORGE_RUNTIME", "");
    expect(asrRuntimeDescriptor().mode).toBe("web");
    expect(asrRuntimeDescriptor().models).toHaveLength(3);
  });
  it("rejects traversal, unknown models, private files and unmanaged runtimes", async () => {
    await fixture("private.json");
    expect(await resolveAsrAsset(["models", "..", "private.json"])).toBeNull();
    expect(await resolveAsrAsset(["models", "other", "model", "config.json"])).toBeNull();
    expect(await resolveAsrAsset(["wasm", "private.json"])).toBeNull();
    const asset = await fixture(`${model}/config.json`, "{}");
    expect(await resolveAsrAsset(["models", ...model.split("/"), "config.json"])).toBe(asset);
    vi.stubEnv("CLIPFORGE_DESKTOP_LOCAL", "");
    expect(await resolveAsrAsset(["models", ...model.split("/"), "config.json"])).toBeNull();
  });
  it("streams local byte ranges and rejects cross-origin requests", async () => {
    await fixture(`${model}/onnx/encoder_model.onnx`, "0123456789");
    const params = Promise.resolve({ path: ["models", ...model.split("/"), "onnx", "encoder_model.onnx"] });
    const response = await GET(new NextRequest("http://localhost:3000/api/runtime/asr/models", { headers: { host: "localhost:3000", range: "bytes=2-4" } }), { params });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("234");
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    const denied = await GET(new NextRequest("http://localhost:3000/api/runtime/asr/models", { headers: { host: "localhost:3000", origin: "https://evil.example" } }), { params });
    expect(denied.status).toBe(403);
  });
});
