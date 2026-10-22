import { existsSync } from "node:fs";

/**
 * ffmpeg / ffprobe binary path resolution — allows commands to target the bundled binary,
 * supporting Electron packaging.
 *
 * Local web: uses an installed bundled binary when available, then the system PATH.
 * Electron package: the main process injects the absolute paths extracted from ffmpeg-static /
 * @ffprobe-installer into FFMPEG_PATH / FFPROBE_PATH, so users don't need to install ffmpeg themselves.
 *
 * Note: return values are interpolated into shell command strings; paths may contain spaces —
 * callers must wrap them in double quotes.
 */

/** Path to the ffmpeg executable (callers must quote it if it contains spaces) */
export function ffmpegBin(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require("ffmpeg-static") as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* A system installation remains supported. */ }
  return "ffmpeg";
}

/** Path to the ffprobe executable (callers must quote it if it contains spaces) */
export function ffprobeBin(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = (require("@ffprobe-installer/ffprobe") as { path: string }).path;
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* A system installation remains supported. */ }
  return "ffprobe";
}
