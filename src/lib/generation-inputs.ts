import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { getUploadsDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";

export interface GenerationInput {
  url: string;
  hash: string;
}

export class GenerationInputError extends Error {
  constructor(public readonly code: "GENERATION_REFERENCE_UNREADABLE" | "GENERATION_REFERENCE_CHANGED", public readonly url: string) {
    super(code === "GENERATION_REFERENCE_CHANGED"
      ? "等待期间所选本地参考素材已变化，已阻止首次付费生成。请重新确认素材。"
      : "所选本地参考素材不存在或无法读取，已阻止首次付费生成。请重新选择素材。");
    this.name = "GenerationInputError";
  }
}

function contentHash(url: string): string {
  try {
    // Only app-local file URLs may reach the resolver; external URLs can contain
    // /api/files/ in their own path, and must never be interpreted as disk paths.
    if (!url.startsWith("/api/files/")) throw new Error("Not an upload URL");
    const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0]);
    const filePath = resolveUploadFilePath(pathname);
    if (!filePath || pathname.includes("\0")) throw new Error("Invalid upload URL");
    const root = realpathSync(getUploadsDir());
    const resolved = realpathSync(filePath);
    const within = relative(root, resolved);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !statSync(resolved).isFile()) {
      throw new Error("Not an uploaded file");
    }
    return createHash("sha256").update(readFileSync(resolved)).digest("hex");
  } catch {
    // Filesystem diagnostics can contain private absolute paths. Keep them out of
    // the durable task's user-facing error while retaining the chosen public URL.
    throw new GenerationInputError("GENERATION_REFERENCE_UNREADABLE", url);
  }
}

/** Freeze the bytes behind every local frame/reference URL in the request snapshot. */
export function captureGenerationInputs(request: Record<string, unknown>): GenerationInput[] {
  const inputs: GenerationInput[] = [];
  const urls = new Set<string>();
  const seen = new WeakSet<object>();
  const pending: unknown[] = [request];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.startsWith("/api/files/") && !urls.has(value)) {
        urls.add(value);
        inputs.push({ url: value, hash: contentHash(value) });
      }
    } else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      const children = Array.isArray(value) ? value : Object.values(value);
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  return inputs;
}

/** Recheck immediately before first paid submission; older snapshots have no inputs. */
export function assertGenerationInputs(inputs: readonly GenerationInput[] | undefined): void {
  for (const input of inputs ?? []) {
    if (contentHash(input.url) !== input.hash) {
      throw new GenerationInputError("GENERATION_REFERENCE_CHANGED", input.url);
    }
  }
}
