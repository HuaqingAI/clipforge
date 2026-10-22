import type { KlingCliDiagnostics, KlingSubmissionDiagnostics } from "./job-types";
import type { KlingCliResult } from "./types";

const LIMIT = 32_768;
const REDACTED = "[已脱敏]";
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|.*(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|password|credentials?|signature)|ticket|secret|token|code_verifier|code_challenge)$/i;
// Bounded key prefixes avoid rescanning a long log line from every character.
const SECRET_PREFIX = /(?<![A-Za-z0-9_-])(?:\\{0,7}["'])?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|[A-Za-z0-9_-]{0,80}(?:access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|password|credentials?|signature)|ticket|secret|token|code_verifier|code_challenge)(?:\\{0,7}["'])?(?:\s|\\[nrt])*[:=](?:\s|\\[nrt])*/gi;

/** Recognize ordinary JSON strings and strings inside escaped/nested JSON logs. */
function quotedValue(text: string, start: number): { end: number; delimiter: string } | undefined {
  const opening = /^(\\{0,7})(["'])/.exec(text.slice(start, start + 9));
  if (!opening) return undefined;
  const escaped = opening[1].length, quote = opening[2];
  let slashes = 0;
  for (let i = start + opening[0].length; i < text.length; i++) {
    const char = text[i];
    if (char === quote && slashes % (2 * (escaped + 1)) === escaped) return { end: i + 1, delimiter: opening[0] };
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return { end: text.length, delimiter: opening[0] };
}

function secretValueEnd(text: string, start: number, header: boolean): { end: number; replacement: string } {
  const quoted = quotedValue(text, start);
  if (quoted) return { end: quoted.end, replacement: quoted.delimiter + REDACTED + quoted.delimiter };
  if (text[start] === "{" || text[start] === "[") {
    const stack: string[] = [];
    for (let i = start; i < text.length; i++) {
      const string = (text[i] === "\\" || text[i] === '"' || text[i] === "'") ? quotedValue(text, i) : undefined;
      if (string) { i = string.end - 1; continue; }
      if (text[i] === "{" || text[i] === "[") stack.push(text[i]);
      else if (text[i] === "}" || text[i] === "]") {
        const expected = text[i] === "}" ? "{" : "[";
        if (stack.pop() !== expected) return { end: text.length, replacement: `"${REDACTED}"` };
        if (!stack.length) return { end: i + 1, replacement: `"${REDACTED}"` };
      }
    }
    return { end: text.length, replacement: `"${REDACTED}"` };
  }
  let end = start;
  if (header) {
    while (end < text.length && !/[\r\n}\]]/.test(text[end])) end++;
    return { end, replacement: `"${REDACTED}"` };
  }
  while (end < text.length && !/[\s,;{}\[\]]/.test(text[end])) end++;
  return { end, replacement: `"${REDACTED}"` };
}

function redactSecrets(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  SECRET_PREFIX.lastIndex = 0;
  for (let match = SECRET_PREFIX.exec(text); match; match = SECRET_PREFIX.exec(text)) {
    const valueStart = match.index + match[0].length;
    const header = /^(?:\\{0,7}["'])?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)(?:\\{0,7}["'])?(?:\s|\\[nrt])*[:=]/i.test(match[0]);
    const { end, replacement } = secretValueEnd(text, valueStart, header);
    parts.push(text.slice(cursor, valueStart), replacement);
    cursor = end;
    SECRET_PREFIX.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function redactCredentialPaths(text: string): string {
  // Split once at line/quote boundaries. A regex that starts at every slash and
  // scans until .credentials becomes quadratic on long slash-heavy CLI output.
  return text.split(/([\r\n"'<>])/).map((segment) => {
    let end = -1;
    for (const match of segment.matchAll(/\.credentials\b/gi)) end = match.index + match[0].length;
    if (end < 0) return segment;
    const start = segment.search(/(?:[A-Za-z]:[\\/]|\/)/);
    return start >= 0 && start < end ? segment.slice(0, start) + "[凭据路径已脱敏]" + segment.slice(end) : segment;
  }).join("");
}

/** Preserve diagnostic wording and JSON structure, while removing credentials and signed URLs. */
export function redactKlingCliText(value: string): string {
  const text = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:(?:\\*\/){2}[^\s<>"']*/gi, (url) => "[URL 已脱敏]" + (url.match(/\\+$/)?.[0] ?? ""))
    .replace(/^([ \t]*(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)[ \t]*[:=][ \t]*)[^\r\n]*/gim, `$1"${REDACTED}"`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  return redactCredentialPaths(redactSecrets(text));
}

function bound(value: string): string {
  if (value.length <= LIMIT) return value;
  const half = Math.floor(LIMIT / 2);
  return value.slice(0, half) + "\n…[内容过长，已截断中段]…\n" + value.slice(-half);
}

export function createKlingCliDiagnostics(result: KlingCliResult | undefined, error: unknown, startedAt: number,
  submission?: KlingSubmissionDiagnostics): KlingCliDiagnostics {
  let truncated = false;
  const safe = (value: string) => {
    const redacted = redactKlingCliText(value);
    truncated ||= redacted.length > LIMIT;
    return bound(redacted);
  };
  let responseJson: string | undefined;
  if (result?.json !== undefined) {
    // Parsed CLI JSON comes from JSON.parse and cannot contain cycles or BigInts.
    try { responseJson = safe(JSON.stringify(result.json, (key, value) => SECRET_KEY.test(key) ? REDACTED : value, 2)); }
    catch { responseJson = "[JSON 层级过深，详见 CLI stdout]"; }
  }
  const now = Date.now();
  const stdout = safe(result?.stdout ?? "");
  const stderr = safe(result?.stderr ?? "");
  const errorText = error instanceof Error ? safe(`${error.name}: ${error.message}`) : undefined;
  return {
    recordedAt: new Date(now).toISOString(), durationMs: Math.max(0, now - startedAt),
    exitCode: result?.exitCode ?? null, signal: result?.signal ?? null,
    timedOut: result?.timedOut ?? false, aborted: result?.aborted ?? false, spawnFailed: result?.spawnFailed ?? false,
    stdout, stderr, responseJson, error: errorText, truncated, submission,
  };
}
