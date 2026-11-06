import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/paths";

type Checkpoint = Record<string, unknown>;
const SAFE_ID = /^[a-zA-Z0-9-]+$/;
const RESULT_FIELDS = new Set(["imageUrl", "imageUrls", "resultUrls", "generationResult", "completedResult", "result", "response"]);
const IMAGE_DATA = /^data:image\/(png|jpe?g|webp|gif|avif|bmp|tiff?);base64,/i;

/** An acknowledged paid image must be durable before its database value becomes a file reference. */
function persistImage(projectId: string, value: string): string {
  const match = IMAGE_DATA.exec(value);
  if (!match) return value;
  if (!SAFE_ID.test(projectId)) throw new Error("无效的图片结果项目编号。");
  const bytes = Buffer.from(value.slice(match[0].length), "base64");
  if (!bytes.length) throw new Error("已生成图片为空，无法保存恢复文件。");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const type = match[1].toLowerCase();
  const ext = type === "jpeg" ? "jpg" : type === "tiff" ? "tif" : type;
  const directory = join(getDataDir(), "uploads", projectId);
  mkdirSync(directory, { recursive: true });
  const name = `generation-result-${hash}.${ext}`;
  const target = join(directory, name);
  if (existsSync(target) && createHash("sha256").update(readFileSync(target)).digest("hex") === hash) return `/api/files/${projectId}/${name}`;
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return `/api/files/${projectId}/${name}`;
}

/** Duplicate result aliases share one content-addressed file; remote and existing local URLs stay intact. */
export function persistGenerationMediaUrls(projectId: string, urls: string[]): string[] {
  const seen = new Map<string, string>();
  return urls.map((url) => {
    if (!seen.has(url)) seen.set(url, persistImage(projectId, url));
    return seen.get(url)!;
  });
}

/** Only output containers are transformed. Frozen provider inputs and plans keep their original meaning. */
export function persistGenerationCheckpointMedia(projectId: string, checkpoint: Checkpoint): Checkpoint {
  const seen = new Map<string, string>();
  const output = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!IMAGE_DATA.test(value)) return value;
      if (!seen.has(value)) seen.set(value, persistImage(projectId, value));
      return seen.get(value)!;
    }
    if (Array.isArray(value)) return value.map(output);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, output(child)]));
    return value;
  };
  return Object.fromEntries(Object.entries(checkpoint).map(([key, value]) => [key, RESULT_FIELDS.has(key) ? output(value) : value]));
}

/** Resolve only a file in this project's uploads directory, never a foreign project or a filesystem path. */
export function generationResultFilePath(projectId: string, url: string): string | undefined {
  if (!SAFE_ID.test(projectId)) return;
  const prefix = `/api/files/${projectId}/`;
  if (!url.startsWith(prefix)) return;
  const name = url.slice(prefix.length);
  if (!name || name === "." || name === ".." || /[/\\\0?#%]/.test(name)) return;
  return join(getDataDir(), "uploads", projectId, name);
}

/** Compact only a finished import whose output files still exist. Unknown or incomplete work retains its paid recovery data. */
export function compactCompletedGenerationCheckpoint(projectId: string, checkpoint: Checkpoint, result: Checkpoint): Checkpoint {
  const paths: string[] = [];
  const originalOutputs = new Set<string>();
  const collectOriginal = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectOriginal); return; }
    for (const [key, child] of Object.entries(value)) {
      if (["imageUrls", "videoUrls", "resultUrls"].includes(key) && Array.isArray(child)) {
        for (const url of child) if (typeof url === "string" && url) originalOutputs.add(url);
      } else if (["imageUrl", "videoUrl"].includes(key) && typeof child === "string" && child) originalOutputs.add(child);
      else if (["generationResult", "result", "response"].includes(key)) collectOriginal(child);
    }
  };
  collectOriginal(checkpoint);
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    for (const [key, child] of Object.entries(value)) {
      if (["imageUrls", "videoUrls", "filePaths"].includes(key) && Array.isArray(child)) {
        paths.push(...child.filter((path): path is string => typeof path === "string"));
      } else if (["filePath", "gridPath"].includes(key) && typeof child === "string") paths.push(child);
      else if (["assets", "asset", "cells"].includes(key)) collect(child);
    }
  };
  collect(result);
  // Historical completed rows may describe only part of a multi-image response.
  // Retain every original paid output unless all distinct outputs have a local counterpart.
  if (originalOutputs.size > new Set(paths).size || (typeof result.gridPath === "string" && originalOutputs.size > 1)) return checkpoint;
  if (!paths.length || !paths.every((url) => {
    const file = generationResultFilePath(projectId, url);
    try { if (!file) return false; const stat = statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; }
  })) return checkpoint;
  const compacted: Checkpoint = { ...checkpoint, completedResult: result };
  // Keep submission IDs, authorization and recovery markers, plans, hashes and local paths.
  // Their original provider response is redundant once completedResult is safely imported.
  for (const key of ["imageUrl", "imageUrls", "videoUrls", "resultUrls", "generationResult", "result", "response"]) delete compacted[key];
  return compacted;
}
