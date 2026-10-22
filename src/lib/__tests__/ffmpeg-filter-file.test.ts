import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile, default: { execFile } }));

import { ffmpegFilterFileArgs, filterFileOptionFromHelp } from "@/lib/ffmpeg-filter-file";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const legacyHelp = "-filter_complex graph_description  create a complex filtergraph\n-filter_complex_script filename  read complex filtergraph description from a file\n";
const modernHelp = "-filter_complex <graph_description>  create a complex filtergraph\n-filter_complex_threads number of threads\n";

beforeEach(() => { execFile.mockReset(); });

describe("FFmpeg filter file compatibility", () => {
  it("retains script loading on FFmpeg 6 and switches to the file prefix on FFmpeg 9", () => {
    expect(filterFileOptionFromHelp(legacyHelp)).toBe("-filter_complex_script");
    expect(filterFileOptionFromHelp(modernHelp)).toBe("-/filter_complex");
    expect(() => filterFileOptionFromHelp("-filter_complex_threads number of threads")).toThrow("不支持");
  });

  it("shares concurrent capability probes and keeps raw paths out of the shell", async () => {
    let finish!: Callback;
    execFile.mockImplementation((_binary, _args, _options, callback: Callback) => { finish = callback; });
    const a = ffmpegFilterFileArgs("C:\\测试 文件\\first.txt", "/ffmpeg/cache-legacy");
    const b = ffmpegFilterFileArgs("C:\\测试 文件\\second.txt", "/ffmpeg/cache-legacy");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual(["/ffmpeg/cache-legacy", ["-hide_banner", "-h", "long"]]);
    finish(null, legacyHelp, "");
    expect(await a).toEqual(["-filter_complex_script", "C:\\测试 文件\\first.txt"]);
    expect(await b).toEqual(["-filter_complex_script", "C:\\测试 文件\\second.txt"]);
    expect(await ffmpegFilterFileArgs("third.txt", "/ffmpeg/cache-legacy")).toEqual(["-filter_complex_script", "third.txt"]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("detects each selected binary separately", async () => {
    execFile.mockImplementation((binary: string, _args, _options, callback: Callback) => callback(null, binary.endsWith("6") ? legacyHelp : modernHelp, ""));
    expect(await ffmpegFilterFileArgs("old.txt", "/selected/6")).toEqual(["-filter_complex_script", "old.txt"]);
    expect(await ffmpegFilterFileArgs("new.txt", "/selected/9")).toEqual(["-/filter_complex", "new.txt"]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed probe and retries after the binary is repaired", async () => {
    const failure = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    execFile.mockImplementationOnce((_binary, _args, _options, callback: Callback) => callback(failure, "", ""));
    await expect(ffmpegFilterFileArgs("filter.txt", "/missing/ffmpeg")).rejects.toBe(failure);
    execFile.mockImplementationOnce((_binary, _args, _options, callback: Callback) => callback(null, modernHelp, ""));
    expect(await ffmpegFilterFileArgs("filter.txt", "/missing/ffmpeg")).toEqual(["-/filter_complex", "filter.txt"]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsupported binary instead of running with a guessed option", async () => {
    execFile.mockImplementation((_binary, _args, _options, callback: Callback) => callback(null, "not FFmpeg", ""));
    await expect(ffmpegFilterFileArgs("filter.txt", "/unsupported/ffmpeg")).rejects.toThrow("不支持");
  });
});
