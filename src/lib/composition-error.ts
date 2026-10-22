import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getOutputDir } from "@/lib/paths";

const MAX_ERROR_LENGTH = 1200;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const FALLBACK_ERROR = "视频合成失败，请重试或查看服务日志";

/** Keep actionable diagnostics, without echoing execFile's full argv and FFmpeg banner. */
export function compositionErrorMessage(error: unknown): string {
  const value = error && typeof error === "object"
    ? error as { message?: unknown; stderr?: unknown }
    : {};
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const stderr = typeof value.stderr === "string" ? value.stderr.trim() : "";
  if (!stderr && message && !message.startsWith("Command failed:")) {
    // composeVideo already translates timeout/disk-full failures into helpful messages.
    return message.slice(0, MAX_ERROR_LENGTH);
  }
  const diagnostics = (stderr || message.replace(/^Command failed:[^\r\n]*(?:\r?\n|$)/, ""))
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:ffmpeg version|built with|configuration:|lib(?:av|sw|postproc)\w*\s+\d|frame=|size=)/i.test(line))
    .slice(-6)
    .join("\n");
  return diagnostics.slice(-MAX_ERROR_LENGTH) || FALLBACK_ERROR;
}

function errorPath(projectId: string, compositionId: string): string | null {
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(compositionId)) return null;
  return join(getOutputDir(), projectId, `.composition-${compositionId}.error.json`);
}

/** Durable failure detail for existing databases, which have no compositions.error column. */
export async function saveCompositionError(projectId: string, compositionId: string, error: unknown): Promise<void> {
  const path = errorPath(projectId, compositionId);
  if (!path) throw new Error("Invalid composition error ID");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ error: compositionErrorMessage(error) }), "utf8");
}

export async function readCompositionError(projectId: string, compositionId: string): Promise<string | null> {
  const path = errorPath(projectId, compositionId);
  if (!path) return null;
  try {
    const detail: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!detail || typeof detail !== "object" || !("error" in detail)) return null;
    return typeof detail.error === "string" && detail.error.trim()
      ? detail.error.trim().slice(0, MAX_ERROR_LENGTH)
      : null;
  } catch {
    // Older failures and incomplete/corrupt sidecars still use the UI's generic fallback.
    return null;
  }
}
