import { KlingCliResult } from "./types";
import { KlingAccessError, klingRouteError } from "./local-access";

export class KlingError extends Error {
  constructor(public code: string, message: string, public status = 400, public result?: KlingCliResult) {
    super(message); this.name = "KlingError";
  }
}

/** No CLI stderr, OAuth URL, local credential paths or raw protocol objects escape here. */
export function klingErrorResponse(error: unknown): Response {
  if (error instanceof KlingError || error instanceof KlingAccessError) return klingRouteError(error);
  if (error instanceof SyntaxError) return klingRouteError(new KlingError("KLING_INVALID_JSON", "请求内容不是有效 JSON。", 400));
  console.error("Kling integration error", error instanceof Error ? error.name : "unknown");
  return klingRouteError(new KlingError("KLING_INTERNAL", "Kling 本地服务发生错误，请重新检测环境。", 500));
}

export function classifyCliFailure(result: KlingCliResult): KlingError {
  if (result.aborted) return new KlingError("KLING_CANCELLED", "Kling 本地操作已取消。", 409, result);
  if (result.timedOut) return new KlingError("KLING_TIMEOUT", "Kling 命令超时。生成操作可能已被云端受理，请查询原任务。", 504, result);
  const detail = `${result.stderr} ${JSON.stringify(result.json ?? {})}`;
  if (/unauthori[sz]ed|not.logged.in|login required|no.credentials|no.login.state|missing.access.token|run:.kling.login|authentication|登录|401|invalid.grant/i.test(detail)) return new KlingError("KLING_AUTH_REQUIRED", "Kling 登录已失效，请重新登录原账号。", 401, result);
  return new KlingError("KLING_CLI_FAILED", "Kling 命令未成功完成，请检查账号状态或稍后查询原任务。", 502, result);
}
