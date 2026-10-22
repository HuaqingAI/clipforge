import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { ffmpegBin, ffprobeBin } from "@/lib/ffmpeg-path";
import { buildComposeCommand, type ComposeConfig } from "@/lib/video-composer/composer";

const origFf = process.env.FFMPEG_PATH;
const origFp = process.env.FFPROBE_PATH;
const loadPackage = createRequire(import.meta.url);
function expectedBinary(name: "ffmpeg" | "ffprobe"): string {
  try {
    const binary = name === "ffmpeg" ? loadPackage("ffmpeg-static") : loadPackage("@ffprobe-installer/ffprobe").path;
    if (binary && existsSync(binary)) return binary;
  } catch { /* System binary is the final fallback. */ }
  return name;
}

afterEach(() => {
  if (origFf === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = origFf;
  if (origFp === undefined) delete process.env.FFPROBE_PATH;
  else process.env.FFPROBE_PATH = origFp;
});

describe("ffmpeg/ffprobe 二进制路径解析", () => {
  it("未注入时优先使用已安装的打包二进制，再回退系统命令", () => {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    expect(ffmpegBin()).toBe(expectedBinary("ffmpeg"));
    expect(ffprobeBin()).toBe(expectedBinary("ffprobe"));
  });

  it("注入绝对路径时返回该路径（Electron 随包二进制）", () => {
    process.env.FFMPEG_PATH = "/Apps/ClipForge.app/Contents/Resources/ffmpeg";
    process.env.FFPROBE_PATH = "/Apps/ClipForge.app/Contents/Resources/ffprobe";
    expect(ffmpegBin()).toContain("ffmpeg");
    expect(ffprobeBin()).toContain("ffprobe");
  });

  it("buildComposeCommand 用注入的 FFMPEG_PATH（含空格被引号包裹）", () => {
    const cfg: ComposeConfig = {
      projectId: "p1",
      clips: [{ type: "image", filePath: "/d/a.jpg", duration: 3, transition: "direct_concat", motion: "static" }],
      output: { resolution: "1080p", aspectRatio: "9:16" },
    };
    process.env.FFMPEG_PATH = "/with space/ffmpeg";
    const cmd = buildComposeCommand(cfg);
    expect(cmd).toContain(`"/with space/ffmpeg" -y`);
  });

  it("未注入时 buildComposeCommand 使用本机解析出的 ffmpeg 路径", () => {
    delete process.env.FFMPEG_PATH;
    const cfg: ComposeConfig = {
      projectId: "p1",
      clips: [{ type: "image", filePath: "/d/a.jpg", duration: 3, transition: "direct_concat", motion: "static" }],
      output: { resolution: "1080p", aspectRatio: "9:16" },
    };
    const cmd = buildComposeCommand(cfg);
    expect(cmd).toContain(`"${expectedBinary("ffmpeg")}" -y`);
  });
});
