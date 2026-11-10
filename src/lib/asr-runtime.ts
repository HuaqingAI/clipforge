import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { LOCAL_ASR_MODELS, type AsrRuntimeDescriptor } from "@/lib/local-asr";
import { isDesktopRuntime, isManagedDesktopRuntime } from "@/lib/runtime-capabilities";

export function asrRuntimeDescriptor(): AsrRuntimeDescriptor {
  if (!isDesktopRuntime()) return { mode: "web", models: LOCAL_ASR_MODELS.map(model => model.id) };
  const directory = process.env.APP_ASR_MODEL_DIR;
  const root = isManagedDesktopRuntime() && directory && isAbsolute(directory) ? directory : "";
  const models = root ? LOCAL_ASR_MODELS.filter(model => ["config.json", "tokenizer.json", "onnx/encoder_model.onnx", "onnx/decoder_model_merged_q4.onnx",
    "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"].every(file => existsSync(join(root, model.id, file)))).map(model => model.id) : [];
  return { mode: "managed", models, modelBaseUrl: "/api/runtime/asr/models/", wasmBaseUrl: "/api/runtime/asr/wasm/" };
}

function inDirectory(root: string, filename: string): boolean {
  const part = relative(root, filename);
  return Boolean(part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Only installed, registered model assets can be served; realpaths fence symlinks. */
export async function resolveAsrAsset(parts: string[]): Promise<string | null> {
  const root = process.env.APP_ASR_MODEL_DIR;
  if (!isManagedDesktopRuntime() || !root || !isAbsolute(root) || parts.length < 2 || parts.length > 8 ||
    parts.some(part => part === "." || part === ".." || !/^[\w.-]+$/.test(part))) return null;
  const [kind, ...resource] = parts;
  if (kind === "models") {
    if (!LOCAL_ASR_MODELS.some(model => model.id === resource.slice(0, 2).join("/")) ||
      !/\.(?:json|txt|onnx|onnx_data)$/.test(resource.at(-1) ?? "")) return null;
  } else if (kind === "wasm") {
    if (resource.length !== 1 || !/^ort-[\w.-]+\.(?:wasm|mjs)$/.test(resource[0])) return null;
  } else return null;
  try {
    const actualRoot = await realpath(root);
    const filename = await realpath(join(root, ...(kind === "wasm" ? ["wasm", ...resource] : resource)));
    return inDirectory(actualRoot, filename) && (await stat(filename)).isFile() ? filename : null;
  } catch { return null; }
}
