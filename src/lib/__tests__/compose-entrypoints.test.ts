// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("CLI compose without automatic music", () => {
  it("ignores legacy music flags while preserving narration, captions and editable audio options", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import { composeBodyFromFlags, parseArgs } from "./bin/clipforge.mjs";
      const { flags } = parseArgs(["compose", "--project", "p", "--bgm", "--bgm-mood", "emotional",
        "--bgm-volume", "24", "--bgm-duck", "--audio-stems", "--voice", "en-US-AriaNeural", "--caption", "minimal"]);
      console.log(JSON.stringify(composeBodyFromFlags(flags)));
    `]);
    const body = JSON.parse(stdout);
    expect(body).not.toHaveProperty("freeBgm");
    expect(body).not.toHaveProperty("bgmMood");
    expect(body).not.toHaveProperty("bgmPath");
    expect(body).toMatchObject({
      freeTts: { enabled: true, voice: "en-US-AriaNeural" }, captionPreset: "minimal",
      bgmVolume: 0.24, bgmDuck: true, exportAudioStems: true,
    });
  });

  it("does not advertise removed flags", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["bin/clipforge.mjs", "--help"]);
    expect(stdout).not.toMatch(/--bgm(?:\s|\])|--bgm-mood/);
    expect(stdout).toContain("--audio-stems");
  });
});
