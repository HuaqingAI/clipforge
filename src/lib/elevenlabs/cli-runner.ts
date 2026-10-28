import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildElevenLabsEnvironment, discoverElevenLabsInstallation, type ElevenLabsInstallation } from "./environment";
import { classifyElevenLabsFailure, ElevenLabsError } from "./errors";

interface RunOptions {
  input?: string;
  timeoutMs?: number;
  installation?: ElevenLabsInstallation;
}

export async function runElevenLabs(args: string[], options: RunOptions = {}): Promise<string> {
  const allowed = ["auth status", "auth login", "voices search", "models list", "text-to-speech convert"];
  if (!allowed.includes(args.slice(0, 2).join(" ")) || args.some((arg) => typeof arg !== "string" || /[\x00\r\n]/.test(arg)) || args.some((arg) => /^--(?:base-url|xi-api-key|debug|spec|with-token)(?:=|$)/.test(arg))) {
    throw new ElevenLabsError("ELEVENLABS_INVALID_COMMAND", "不支持的 ElevenLabs CLI 命令。", 400);
  }
  const installation = options.installation ?? await discoverElevenLabsInstallation();
  // CLI dotenv discovery must not import project .env API keys or endpoint overrides.
  const directory = await mkdtemp(join(tmpdir(), "clipforge-elevenlabs-cli-"));
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(installation.executable, args, { shell: false, windowsHide: true, cwd: directory, env: buildElevenLabsEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    } catch { reject(new ElevenLabsError("ELEVENLABS_SPAWN_FAILED", "ElevenLabs CLI 无法启动，请检查安装。")); return; }
    let stdout = "", stderr = "", totalBytes = 0, finished = false;
    let failure: ElevenLabsError | undefined;
    const outDecoder = new StringDecoder("utf8"), errDecoder = new StringDecoder("utf8");
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: ElevenLabsError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      if (error) reject(error); else resolve(stdout);
    };
    const stop = (error: ElevenLabsError) => {
      failure ??= error;
      child.kill();
      hardKill ??= setTimeout(() => { child.kill("SIGKILL"); finish(failure); }, 5_000);
      hardKill.unref();
    };
    const timer = setTimeout(() => stop(new ElevenLabsError("ELEVENLABS_TIMEOUT", "ElevenLabs 请求超时；生成请求可能已被处理，请检查账号记录后再重试。", 504)), options.timeoutMs ?? 45_000);
    const receive = (chunk: Buffer, stderrStream: boolean) => {
      totalBytes += chunk.length;
      if (totalBytes > 4 * 1024 * 1024) { stop(new ElevenLabsError("ELEVENLABS_OUTPUT_TOO_LARGE", "ElevenLabs CLI 返回内容超过限制。")); return; }
      if (stderrStream) stderr += errDecoder.write(chunk); else stdout += outDecoder.write(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => receive(chunk, false));
    child.stderr!.on("data", (chunk: Buffer) => receive(chunk, true));
    child.once("error", () => finish(new ElevenLabsError("ELEVENLABS_SPAWN_FAILED", "ElevenLabs CLI 无法启动，请检查安装。")));
    child.once("close", (code) => {
      stdout += outDecoder.end(); stderr += errDecoder.end();
      finish(failure ?? (code === 0 ? undefined : classifyElevenLabsFailure(stderr + stdout)));
    });
    // The script and settings never appear in process arguments or shell history.
    child.stdin!.on("error", () => { /* close/error carries the CLI failure; never echo stdin */ });
    child.stdin!.end(options.input ?? "");
  }).finally(() => rm(directory, { recursive: true, force: true }).catch(() => undefined));
}
