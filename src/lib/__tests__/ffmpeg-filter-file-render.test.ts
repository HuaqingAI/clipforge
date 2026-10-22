import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { it } from "vitest";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { ffmpegFilterFileArgs } from "@/lib/ffmpeg-filter-file";

const run = promisify(execFile);

it("loads a graph larger than Windows argv limits through a file with a Unicode/space path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipforge 滤镜 "));
  try {
    const filterPath = join(directory, "large graph.txt");
    await writeFile(filterPath, `[0:v]metadata=mode=add:key=long:value=${"x".repeat(40_000)}[v]`, "utf8");
    const binary = ffmpegBin();
    await run(binary, [
      "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.04",
      ...await ffmpegFilterFileArgs(filterPath, binary), "-map", "[v]", "-frames:v", "1", "-f", "null", "-",
    ], { timeout: 10_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
