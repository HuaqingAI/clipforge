import { execFile } from "child_process";
import { ffmpegBin } from "@/lib/ffmpeg-path";

type FilterFileOption = "-filter_complex_script" | "-/filter_complex";

/** FFmpeg 9 removed the old script option; newer builds load option values with the / prefix. */
export function filterFileOptionFromHelp(help: string): FilterFileOption {
  if (/^\s*-filter_complex_script(?:\s|$)/m.test(help)) return "-filter_complex_script";
  if (/^\s*-filter_complex(?:\s|$)/m.test(help)) return "-/filter_complex";
  throw new Error("当前 FFmpeg 不支持从文件加载复杂滤镜，请安装完整版本的 FFmpeg");
}

// Reuse in-flight probes too: concurrent renders should only launch one cheap help process per binary.
const optionCache = new Map<string, Promise<FilterFileOption>>();

function probeFilterFileOption(binary: string): Promise<FilterFileOption> {
  return new Promise((resolve, reject) => {
    // `long` includes global/advanced CLI options without the megabytes of codec help in `full`.
    execFile(binary, ["-hide_banner", "-h", "long"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      try { resolve(filterFileOptionFromHelp(`${stdout}\n${stderr}`)); }
      catch (cause) { reject(cause); }
    });
  });
}

/** Keep large graphs out of argv on both old and new FFmpeg, preserving shell-free Windows renders. */
export async function ffmpegFilterFileArgs(filterPath: string, binary = ffmpegBin()): Promise<[FilterFileOption, string]> {
  let option = optionCache.get(binary);
  if (!option) {
    option = probeFilterFileOption(binary);
    optionCache.set(binary, option);
    // A repaired installation can be retried without restarting the server.
    void option.catch(() => { if (optionCache.get(binary) === option) optionCache.delete(binary); });
  }
  return [await option, filterPath];
}
