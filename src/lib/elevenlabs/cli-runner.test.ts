// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { runElevenLabs } from "./cli-runner";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const installation = { executable: "C:\\Program Files\\ElevenLabs & CLI\\elevenlabs.exe", version: "1.8.0" };
function childFixture(reply: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.stdin.on("finish", () => queueMicrotask(() => reply(child)));
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return child;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("ElevenLabs bounded native process runner", () => {
  it("pipes JSON input, uses literal argv, and hides the Windows process", async () => {
    const child = childFixture((process) => { process.stdout.write('{"ok":true}'); process.emit("close", 0); });
    const input = JSON.stringify({ text: 'Hello & $(never run) "世界"' });
    let captured = ""; child.stdin.on("data", (chunk) => { captured += chunk.toString(); });
    const args = ["text-to-speech", "convert", "--voice-id", "voice_1", "--json", "-", "--no-retry"];
    expect(await runElevenLabs(args, { installation, input })).toBe('{"ok":true}');
    expect(captured).toBe(input);
    expect(spawn).toHaveBeenCalledWith(installation.executable, args, expect.objectContaining({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
    expect(JSON.stringify(vi.mocked(spawn).mock.calls[0][1])).not.toContain("never run");
  });
  it("never exposes credential-bearing stderr or retries an unsuccessful generation", async () => {
    childFixture((process) => { process.stderr.write("401 invalid token secret-do-not-expose"); process.emit("close", 1); });
    await expect(runElevenLabs(["text-to-speech", "convert", "--no-retry"], { installation })).rejects.toMatchObject({ code: "ELEVENLABS_LOGIN_REQUIRED", retryable: false, message: expect.not.stringContaining("secret-do-not-expose") });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("limits output and terminates an unresponsive child on timeout", async () => {
    vi.useFakeTimers();
    const child = childFixture(() => {});
    const pending = runElevenLabs(["auth", "status"], { installation, timeoutMs: 20 });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ELEVENLABS_TIMEOUT" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_021);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("stops collecting excessive output and returns a sanitized error", async () => {
    childFixture((process) => { process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1)); process.emit("close", 0); });
    await expect(runElevenLabs(["models", "list"], { installation })).rejects.toMatchObject({ code: "ELEVENLABS_OUTPUT_TOO_LARGE" });
  });
  it("blocks arbitrary command surfaces and credential/endpoint overrides before spawning", async () => {
    await expect(runElevenLabs(["voices", "delete"], { installation })).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_COMMAND" });
    await expect(runElevenLabs(["models", "list", "--base-url", "https://invalid.test"], { installation })).rejects.toMatchObject({ code: "ELEVENLABS_INVALID_COMMAND" });
    expect(spawn).not.toHaveBeenCalled();
  });
});
