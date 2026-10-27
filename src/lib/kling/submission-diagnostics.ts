import { KlingError } from "./errors";
import { extractGenerationId, parseCliJson, record } from "./protocol";
import type { KlingSubmissionDiagnostics } from "./job-types";
import type { KlingCliResult } from "./types";

interface FailureEvidence {
  phase: KlingSubmissionDiagnostics["phase"];
  source: KlingSubmissionDiagnostics["source"];
  code: string;
  message: string;
  status: number;
  httpStatus?: number;
  remoteCode?: string;
}

const UPLOAD_FAILURE = "参考图片上传失败，未提交视频生成。请检查图片和网络后重新确认生成。";
const UNSUPPORTED_FORMAT = "参考图片上传被 Kling 拒绝，未提交视频生成。请使用 PNG 或 JPEG 图片后重新确认生成。";
const VALIDATION_FAILURE = "Kling CLI 的参数或参考图校验未通过，未提交视频生成。请刷新模型能力并检查参数和图片。";
const MODEL_FAILURE = "Kling 当前模型能力已变化或无法读取，未提交视频生成。请刷新模型列表后重新选择。";
const AUTH_FAILURE = "Kling 登录状态已失效，未提交视频生成。请重新登录原账号。";

/** Map trusted local codes to fixed text; even a KlingError message may contain provider text. */
const STARTUP_ERRORS: Record<string, { message: string; status: number }> = {
  KLING_NODE_UNAVAILABLE: { message: "Node.js 不可用，未提交视频生成。请重新检测 Kling 环境。", status: 400 },
  KLING_NOT_FOUND: { message: "未找到 Kling CLI，未提交视频生成。请重新检测环境。", status: 400 },
  KLING_INVALID_PACKAGE: { message: "Kling CLI 安装无效，未提交视频生成。请重新检测环境。", status: 400 },
  KLING_UNSUPPORTED_VERSION: { message: "Kling CLI 版本不受支持，未提交视频生成。请检测固定版本安装。", status: 400 },
  KLING_ENVIRONMENT_FAILED: { message: "Kling 环境检测失败，未提交视频生成。请重新检测环境。", status: 400 },
  KLING_ENVIRONMENT_CHANGED: { message: "Kling 安装已变化，未提交视频生成。请重新检测环境。", status: 409 },
  KLING_ENVIRONMENT_REQUIRED: { message: "Kling 环境尚未就绪，未提交视频生成。请先检测环境。", status: 409 },
  KLING_LEGACY_CREDENTIALS: { message: "Kling 安装中存在旧版凭据，未提交视频生成。请先处理旧安装。", status: 409 },
  KLING_PROFILE_BUSY: { message: "Kling 账号正在执行其他操作，本次未提交视频生成。请稍后重新确认。", status: 409 },
  KLING_PROFILE_DISABLED: { message: "Kling 配置已停用，未提交视频生成。", status: 409 },
  KLING_PROFILE_NOT_FOUND: { message: "Kling 配置不存在，未提交视频生成。", status: 404 },
  KLING_INVALID_LEASE: { message: "Kling 操作锁不匹配，未提交视频生成。请刷新后重新确认。", status: 409 },
  KLING_LEASE_LOST: { message: "Kling 操作锁已失效，本次未启动视频生成。请刷新后核对原任务。", status: 409 },
  KLING_INVALID_COMMAND: { message: "Kling 命令参数无效，未提交视频生成。请检查生成设置。", status: 400 },
  KLING_ARGUMENTS_TOO_LONG: { message: "Kling 输入参数过长，未提交视频生成。请缩短提示词。", status: 400 },
  KLING_CANCELLED: { message: "本地操作已在启动前取消，未提交视频生成。", status: 409 },
  KLING_INPUT_INVALID: { message: "生成输入校验失败，未提交视频生成。请检查提示词和图片。", status: 422 },
  KLING_INPUT_CHANGED: { message: "生成输入已变化，未提交视频生成。请重新确认图片和参数。", status: 409 },
  KLING_CAPABILITY_UNSUPPORTED: { message: "Kling CLI 拒绝了本次参数或输入，未提交视频生成。请查看返回详情。", status: 422 },
  KLING_MEDIA_TOOL_UNAVAILABLE: { message: "本地媒体工具不可用，未提交视频生成。请检查工具配置。", status: 422 },
  KLING_CONTEXT_CHANGED: { message: "当前脚本或镜头已变化，未提交视频生成。请刷新后重新确认。", status: 409 },
  KLING_AUTH_REQUIRED: { message: AUTH_FAILURE, status: 401 },
  KLING_LOGIN_REQUIRED: { message: "Kling 账号尚未登录或核验，未提交视频生成。请先登录原账号。", status: 401 },
  KLING_ACCOUNT_MISMATCH: { message: "当前 Kling 账号与原账号不一致，未提交视频生成。请切回原账号。", status: 409 },
  KLING_CLI_VERSION_UNSUPPORTED: { message: "原任务的 Kling CLI 版本与当前版本不一致，未提交视频生成。请恢复支持版本。", status: 409 },
};

function cliResult(result?: KlingCliResult, error?: unknown): KlingCliResult | undefined {
  return result ?? (error instanceof KlingError ? error.result : undefined);
}

function acknowledged(result: KlingCliResult | undefined): boolean {
  return !!result && !!(result.generationId || extractGenerationId(result.json) || extractGenerationId(parseCliJson(result.stdout)));
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function unsupportedFileType(body: unknown): boolean {
  const parsed = record(body);
  return parsed.result === 1 && parsed.data === null && record(parsed.error).type === "AGENT.UnsupportedFileType";
}

/** The pinned CLI may append its upgrade notice after the terminal error. */
function terminalLine(stderr: string): string {
  const lines = stderr.trimEnd().split(/\r?\n/);
  if (/^\[kling\] (?:New version [^\r\n]+ found \(current 0\.2\.0\)\. Upgrade and try again: |发现新版本 [^\r\n]+（当前 0\.2\.0）。建议升级后重试：)[^\r\n]*@klingai\/cli-global[^\r\n]*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.at(-1) ?? "";
}

function failureEvidence(result?: KlingCliResult, error?: unknown): FailureEvidence | undefined {
  if (!result || acknowledged(result)) return undefined;
  if (result.spawnFailed) {
    const code = error instanceof KlingError && Object.hasOwn(STARTUP_ERRORS, error.code) ? error.code : "KLING_SPAWN_FAILED";
    const detail = STARTUP_ERRORS[code] ?? { message: "Kling CLI 无法启动，未提交视频生成。请重新检测环境。", status: 502 };
    return { phase: "startup", source: "process", code, ...detail };
  }
  // A killed/interrupted CLI may already have sent a generation request. Never infer rejection
  // from a log fragment or an error code merely mentioned by a transport exception.
  if (result.timedOut || result.aborted || result.signal || result.exitCode !== 1) return undefined;

  const json = result.json ?? parseCliJson(result.stdout);
  const response = record(json);
  // MCP's outer status=400 only means isError=true. It also wraps unknown server errors,
  // so only an explicitly understood rejection body proves no task was created.
  if (response.ok === false && unsupportedFileType(response.body)) {
    return { phase: "submission", source: "platform", code: "KLING_INPUT_FORMAT_UNSUPPORTED", message: UNSUPPORTED_FORMAT, status: 422, remoteCode: "AGENT.UnsupportedFileType" };
  }
  if (json !== undefined || result.stdout.trim()) return undefined;

  const line = terminalLine(result.stderr);
  // submitGeneration writes this evidence only after all local validation has passed.
  // Reject contradictory logs instead of treating an earlier upload/validation line as terminal.
  if (/(?:^|\r?\n)\[kling\] (?:Submit arguments:|提交 arguments：)/.test(result.stderr) ||
      /(?:^|\r?\n)MCP (?:tool call failed|工具调用失败) \((?:image_to_video|text_to_video)\)[：:]/.test(result.stderr)) return undefined;

  const upload = /^Failed to upload [^\r\n]+?: (\{[^\r\n]*\})$/.exec(line);
  if (upload) {
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(upload[1])); } catch { return undefined; }
    if (typeof parsed.ok !== "boolean" || httpStatus(parsed.status) === undefined || !Object.hasOwn(parsed, "body")) return undefined;
    const unsupported = unsupportedFileType(parsed.body);
    return { phase: "upload", source: "platform", code: unsupported ? "KLING_INPUT_FORMAT_UNSUPPORTED" : "KLING_UPLOAD_FAILED", message: unsupported ? UNSUPPORTED_FORMAT : UPLOAD_FAILURE, status: 422,
      httpStatus: httpStatus(parsed.status), ...(unsupported ? { remoteCode: "AGENT.UnsupportedFileType" } : {}) };
  }
  if (/^(?:File upload failed \([^\r\n]+\): |文件上传失败（[^\r\n]+）：|file_upload ticket response is missing ticket\/uploadUrl: |file_upload 票据响应缺少 ticket\/uploadUrl：|MCP tool call failed \(file_upload\): |MCP 工具调用失败 \(file_upload\)：)[^\r\n]*$/.test(line)) {
    return { phase: "upload", source: "cli", code: "KLING_UPLOAD_FAILED", message: UPLOAD_FAILURE, status: 422 };
  }
  if (/^(?:Unknown parameter --[A-Za-z_][A-Za-z0-9_-]*\. Model [^\r\n]+ declares these generation parameters: [^\r\n]+ \(flags may use snake_case or camelCase; run kling who_am_i for the full spec\)\.|未知参数 --[A-Za-z_][A-Za-z0-9_-]*。模型 [^\r\n]+ 声明的生成参数：[^\r\n]+（flag 用 snake_case 或 camelCase 均可，规格详见 kling who_am_i）)$/.test(line) ||
      /^(?:Model [^\r\n]+ requires at least \d+ reference image\(s\) \(required inputs: [^\r\n]+\), but only \d+ were provided\. Add them with --image \(run kling who_am_i for the full spec\)\.|模型 [^\r\n]+ 需要至少 \d+ 张参考图（必填输入：[^\r\n]+），但只提供了 \d+ 张。请用 --image 补齐（规格详见 kling who_am_i）。|prompt cannot be empty|prompt 不能为空)$/.test(line)) {
    return { phase: "validation", source: "cli", code: "KLING_SUBMISSION_VALIDATION_FAILED", message: VALIDATION_FAILURE, status: 422 };
  }
  if (/^(?:Model "[^"\r\n]+" is not available for (?:image_to_video|text_to_video)\. Available models: [^\r\n]*|模型 "[^"\r\n]+" 不在 (?:image_to_video|text_to_video) 的可用列表内。可用：[^\r\n]*|Capability discovery \(who_am_i\) failed: [^\r\n]*|能力发现（who_am_i）失败：[^\r\n]*|MCP tool call failed \(who_am_i\): [^\r\n]*|MCP 工具调用失败 \(who_am_i\)：[^\r\n]*|The server did not configure any available models for (?:image_to_video|text_to_video) \(who_am_i.available_models is empty\)\. Contact the server owner to confirm\.|服务端未为 (?:image_to_video|text_to_video) 配置可用模型（who_am_i.available_models 为空），请联系服务端确认。)$/.test(line)) {
    return { phase: "validation", source: "cli", code: "KLING_MODEL_UNAVAILABLE", message: MODEL_FAILURE, status: 422 };
  }
  if (/^(?:No login state found for the configured endpoint \(\.credentials is missing ACCESS_TOKEN\)\. Run: kling login|Login has expired and no refresh token is available\. Run again: kling login|Credentials are missing CLIENT_ID, so the token cannot be refreshed\. Run again: kling login|The login state is no longer valid\. Run again: kling login|当前端点尚无登录态（\.credentials 缺 ACCESS_TOKEN）。请运行: kling login|登录已过期（无 refresh token）。请重新运行: kling login|登录已过期且无 refresh token，请重新运行: kling login|凭据缺少 CLIENT_ID，无法刷新 token，请重新运行: kling login|登录态已失效，请重新运行: kling login)$/.test(line)) {
    return { phase: "startup", source: "cli", code: "KLING_AUTH_REQUIRED", message: AUTH_FAILURE, status: 401 };
  }
  return undefined;
}

/** Only evidence that proves generation was never submitted permits this classification. */
export function classifyKlingSubmissionFailure(result?: KlingCliResult, error?: unknown): KlingError | undefined {
  const evidence = failureEvidence(cliResult(result, error), error);
  return evidence ? new KlingError(evidence.code, evidence.message, evidence.status) : undefined;
}

/** Browser-safe summary. Raw CLI output belongs in the separately redacted diagnostic record. */
export function createKlingSubmissionDiagnostics(result?: KlingCliResult, error?: unknown): KlingSubmissionDiagnostics | undefined {
  const resolved = cliResult(result, error);
  if (acknowledged(resolved)) return undefined;
  const evidence = failureEvidence(resolved, error);
  const response = resolved?.json ?? (resolved ? parseCliJson(resolved.stdout) : undefined);
  return {
    phase: evidence?.phase ?? "submission", outcome: evidence ? "not_submitted" : "unknown", source: evidence?.source ?? (response !== undefined ? "platform" : resolved?.stderr.trim() ? "cli" : "process"),
    reason: evidence?.message ?? (resolved?.timedOut ? "Kling CLI 在取得任务编号前超时，提交结果无法确认。" : resolved?.aborted ? "Kling CLI 在取得任务编号前被取消，提交结果无法确认。" : "Kling CLI 未返回可确认的任务编号或明确拒绝证据，提交结果无法确认。"),
    ...(resolved ? { exitCode: resolved.exitCode, timedOut: !!resolved.timedOut, aborted: !!resolved.aborted } : { timedOut: false, aborted: false }),
    ...(evidence ? { localCode: evidence.code } : {}),
    ...(evidence?.httpStatus !== undefined ? { httpStatus: evidence.httpStatus } : {}),
    ...(evidence?.remoteCode ? { remoteCode: evidence.remoteCode } : {}),
  };
}
