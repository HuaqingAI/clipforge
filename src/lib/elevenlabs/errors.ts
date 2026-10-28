export class ElevenLabsError extends Error {
  readonly retryable = false;
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/** Provider stderr is classified internally and is never returned to the browser. */
export function classifyElevenLabsFailure(output: string): ElevenLabsError {
  if (/401|unauthori[sz]ed|not.?logged.?in|no (?:stored )?credential|authentication|invalid.?api.?key|token.{0,30}(?:expired|invalid)/i.test(output)) {
    return new ElevenLabsError("ELEVENLABS_LOGIN_REQUIRED", "ElevenLabs 登录已失效，请重新完成 OAuth 授权。", 401);
  }
  if (/quota|insufficient|subscription|payment|credits|402/i.test(output)) {
    return new ElevenLabsError("ELEVENLABS_QUOTA", "ElevenLabs 额度或订阅权限不足，请在 ElevenLabs 检查账号。", 402);
  }
  if (/429|rate.?limit|too many requests/i.test(output)) {
    return new ElevenLabsError("ELEVENLABS_RATE_LIMIT", "ElevenLabs 请求过于频繁，请稍后重试。", 429);
  }
  if (/403|forbidden|permission|scope/i.test(output)) {
    return new ElevenLabsError("ELEVENLABS_PERMISSION", "ElevenLabs 授权权限不足，请重新授权并检查声音和模型权限。", 403);
  }
  return new ElevenLabsError("ELEVENLABS_CLI_FAILED", "ElevenLabs CLI 操作失败，请检查网络、账号以及所选声音和模型；生成请求不会自动重试。");
}
