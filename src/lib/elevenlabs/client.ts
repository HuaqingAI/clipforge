import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runElevenLabs } from "./cli-runner";
import { discoverElevenLabsInstallation } from "./environment";
import { ElevenLabsError } from "./errors";
import { validateElevenLabsConfig } from "./config";
import type { ElevenLabsAuthState, ElevenLabsCatalog, ElevenLabsStatus, ElevenLabsVoice } from "./types";

interface LocalState {
  auth: ElevenLabsAuthState;
  login?: Promise<void>;
  catalog?: { value: ElevenLabsCatalog; expires: number };
  catalogRequest?: Promise<ElevenLabsCatalog>;
}
const globalState = globalThis as typeof globalThis & { __clipforgeElevenLabs?: LocalState };
const state = globalState.__clipforgeElevenLabs ??= { auth: { state: "idle" } };
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max = 512): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function parse(output: string): unknown {
  try { return JSON.parse(output); }
  catch { throw new ElevenLabsError("ELEVENLABS_INVALID_RESPONSE", "ElevenLabs CLI 没有返回有效 JSON，请检查固定版本安装。"); }
}

export async function getElevenLabsStatus(): Promise<ElevenLabsStatus> {
  let installation;
  try { installation = await discoverElevenLabsInstallation(); }
  catch (error) {
    return { installed: false, authenticated: false, message: error instanceof ElevenLabsError ? error.message : "ElevenLabs CLI 环境检测失败。", auth: { ...state.auth } };
  }
  try {
    const auth = record(parse(await runElevenLabs(["auth", "status", "--json"], { installation })));
    const schemes = Array.isArray(auth.schemes) ? auth.schemes : [];
    const authenticated = schemes.some((scheme) => record(scheme).logged_in === true);
    return { installed: true, authenticated, version: installation.version, message: authenticated ? "已连接本机 ElevenLabs OAuth 账号" : "请通过浏览器完成 ElevenLabs OAuth 授权", auth: { ...state.auth } };
  } catch (error) {
    return { installed: true, authenticated: false, version: installation.version, message: error instanceof ElevenLabsError ? error.message : "ElevenLabs 登录状态检测失败。", auth: { ...state.auth } };
  }
}

export async function startElevenLabsLogin(): Promise<ElevenLabsAuthState> {
  if (state.login) return { ...state.auth };
  const installation = await discoverElevenLabsInstallation();
  // Concurrent clicks can both await discovery; only one browser flow may own the callback port.
  if (state.auth.state === "pending") return { ...state.auth };
  state.auth = { state: "pending", message: "已打开 ElevenLabs 授权页面，请在浏览器中完成登录。" };
  state.catalog = undefined;
  state.login = runElevenLabs(["auth", "login", "--scheme", "OAuth", "--format", "json"], { installation, timeoutMs: 330_000 }).then(() => {
    state.auth = { state: "success", message: "ElevenLabs OAuth 授权完成。" };
  }).catch((error: unknown) => {
    state.auth = { state: "error", message: error instanceof ElevenLabsError ? error.message : "ElevenLabs OAuth 授权失败，请重试。" };
  }).finally(() => { state.login = undefined; });
  return { ...state.auth };
}

async function loadCatalog(): Promise<ElevenLabsCatalog> {
  const installation = await discoverElevenLabsInstallation();
  const voices: ElevenLabsVoice[] = [];
  let nextPage: string | undefined;
  let more = false;
  for (let page = 0; page < 20; page++) {
    const args = ["voices", "search", "--page-size", "100", "--format", "json", "--no-retry"];
    if (nextPage) args.push("--next-page-token", nextPage);
    const result = record(parse(await runElevenLabs(args, { installation })));
    if (!Array.isArray(result.voices)) throw new ElevenLabsError("ELEVENLABS_INVALID_RESPONSE", "ElevenLabs 声音列表格式无效。");
    for (const item of result.voices) {
      const voice = record(item);
      const id = text(voice.voice_id, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) continue;
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(record(voice.labels)).slice(0, 30)) if (typeof value === "string") labels[key.slice(0, 64)] = value.slice(0, 128);
      voices.push({ id, name: text(voice.name) || id, category: text(voice.category, 64) || undefined, labels });
    }
    more = result.has_more === true;
    if (!more) break;
    const token = text(result.next_page_token, 4096);
    if (!token || token === nextPage || /[\x00\r\n]/.test(token)) throw new ElevenLabsError("ELEVENLABS_INVALID_RESPONSE", "ElevenLabs 声音列表分页无效。");
    nextPage = token;
  }
  if (more) throw new ElevenLabsError("ELEVENLABS_CATALOG_TOO_LARGE", "ElevenLabs 声音列表超过 2000 个，请在账号中整理声音后重试。");
  const modelResult = parse(await runElevenLabs(["models", "list", "--format", "json", "--no-retry"], { installation }));
  if (!Array.isArray(modelResult)) throw new ElevenLabsError("ELEVENLABS_INVALID_RESPONSE", "ElevenLabs 模型列表格式无效。");
  const models = modelResult.filter((item) => record(item).can_do_text_to_speech === true).flatMap((item) => {
    const model = record(item), id = text(model.model_id, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return [];
    return [{ id, name: text(model.name) || id, description: text(model.description, 2048) || undefined,
      languages: (Array.isArray(model.languages) ? model.languages : []).map((language) => ({ id: text(record(language).language_id, 64), name: text(record(language).name, 128) })) }];
  });
  return { voices: [...new Map(voices.map((voice) => [voice.id, voice])).values()], models };
}

export async function getElevenLabsCatalog(): Promise<ElevenLabsCatalog> {
  if (state.catalog && state.catalog.expires > Date.now()) return state.catalog.value;
  state.catalogRequest ??= loadCatalog().then((value) => { state.catalog = { value, expires: Date.now() + 60_000 }; return value; }).finally(() => { state.catalogRequest = undefined; });
  return state.catalogRequest;
}

export async function generateElevenLabsSpeech(input: string, options: { voice?: string; model?: string; speed?: number }): Promise<Buffer> {
  const validated = validateElevenLabsConfig(options);
  if (!validated.ok) throw new ElevenLabsError("ELEVENLABS_INVALID_CONFIG", validated.error, 400);
  if (typeof input !== "string" || !input.trim() || input.length > 100_000 || input.includes("\0")) throw new ElevenLabsError("ELEVENLABS_INVALID_TEXT", "ElevenLabs 口播文案不能为空，且不能超过 100000 字符。", 400);
  const config = validated.config;
  const installation = await discoverElevenLabsInstallation();
  const directory = await mkdtemp(join(tmpdir(), "clipforge-elevenlabs-"));
  const output = join(directory, "speech.mp3");
  try {
    await runElevenLabs(["text-to-speech", "convert", "--voice-id", config.voice, "--output-format", "mp3_44100_128", "--output", output, "--json", "-", "--no-retry"], {
      installation, timeoutMs: 180_000,
      input: JSON.stringify({ text: input, model_id: config.model, voice_settings: { speed: config.speed ?? 1 } }),
    });
    let size = 0;
    try { size = (await stat(output)).size; } catch { /* mapped to safe output error */ }
    if (size < 4 || size > 32 * 1024 * 1024) throw new ElevenLabsError("ELEVENLABS_INVALID_AUDIO", "ElevenLabs 未返回有效音频或音频超过 32MB，请检查生成记录。");
    const audio = await readFile(output);
    const id3 = audio.subarray(0, 3).toString("ascii") === "ID3";
    const mpeg = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
    if (!id3 && !mpeg) throw new ElevenLabsError("ELEVENLABS_INVALID_AUDIO", "ElevenLabs 返回的文件不是有效 MP3，请检查生成记录。");
    return audio;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
