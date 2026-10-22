import { describe, expect, it } from "vitest";
import { createKlingCliDiagnostics, redactKlingCliText } from "./cli-diagnostics";
import type { KlingCliResult } from "./types";

const result = (overrides: Partial<KlingCliResult> = {}): KlingCliResult => ({
  exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, ...overrides,
});

describe("Kling CLI diagnostics", () => {
  it("retains the actual response and error while redacting nested credentials and URLs", () => {
    const json = { ok: false, body: { error: { type: "AGENT.InvalidParameter", detail: "duration must be 5" },
      access_token: "PRIVATE_ACCESS", nested: { refreshToken: "PRIVATE_REFRESH", ticket: "PRIVATE_TICKET" },
      url: "https://private.invalid/image?signature=PRIVATE_SIGNED" } };
    const diagnostic = createKlingCliDiagnostics(result({ json, stdout: JSON.stringify(json),
      stderr: 'Authorization: Bearer PRIVATE_BEARER\nREFRESH_TOKEN=PRIVATE_ENV\nFailed to upload C:\\fixture\\image.png: invalid input',
    }), new Error("MCP tool call failed (image_to_video): invalid duration"), Date.now() - 100);
    expect(diagnostic.stdout).toContain("AGENT.InvalidParameter");
    expect(diagnostic.responseJson).toContain("duration must be 5");
    expect(diagnostic.stderr).toContain("Failed to upload");
    expect(diagnostic.error).toContain("invalid duration");
    expect(diagnostic.durationMs).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_|private\.invalid/);
  });

  it("redacts multiline JSON, JWTs and credential paths without losing platform error messages", () => {
    const raw = '{\n  "body": {\n    "access_token": "secret-value",\n    "error": "insufficient credits"\n  }\n}\n' +
      'eyJabc.def.ghi C:\\user\\.credentials https://example.invalid/oauth?code=private';
    const safe = redactKlingCliText(raw);
    expect(safe).toContain("insufficient credits");
    expect(safe).not.toMatch(/secret-value|eyJabc|C:\\user|private|example\.invalid/);
  });

  it("bounds persisted output while retaining the leading response and terminal error", () => {
    const diagnostic = createKlingCliDiagnostics(result({ stderr: "START\n" + "x".repeat(70_000) + "\nFINAL ERROR" }), undefined, Date.now());
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.stderr.length).toBeLessThan(33_000);
    expect(diagnostic.stderr.startsWith("START")).toBe(true);
    expect(diagnostic.stderr.endsWith("FINAL ERROR")).toBe(true);
  });

  it("preserves launch failures without inventing a process exit status", () => {
    const diagnostic = createKlingCliDiagnostics(undefined, new Error("CLI installation missing"), Date.now());
    expect(diagnostic).toMatchObject({ exitCode: null, stdout: "", stderr: "", error: "Error: CLI installation missing", timedOut: false });
  });

  it("redacts credentials and slash-escaped URLs inside nested JSON log strings", () => {
    const embedded = JSON.stringify({ access_token: "PRIVATE_ACCESS", credentials: { nested: "PRIVATE_NESTED" },
      url: "https://private.invalid/image?signature=PRIVATE_SIGNATURE", error: "invalid duration" });
    const raw = JSON.stringify({ message: embedded }).replaceAll("/", "\\/");
    const twice = JSON.stringify({ message: raw });
    for (const text of [raw, twice]) {
      const safe = redactKlingCliText(text);
      expect(safe).toContain("invalid duration");
      expect(safe).not.toMatch(/PRIVATE_|private\.invalid/);
    }
  });

  it("redacts complete structured secret values and retains surrounding error details", () => {
    const text = JSON.stringify({ credentials: { first: "PRIVATE_ONE", nested: [{ another: "PRIVATE_TWO" }] },
      cookie: ["PRIVATE_THREE", { session: "PRIVATE_FOUR" }], error: "quota exceeded", status: 400 });
    const safe = redactKlingCliText(text);
    expect(safe).not.toContain("PRIVATE_");
    expect(safe).toContain("quota exceeded");
    expect(safe).toContain('"status":400');
  });

  it("redacts all cookie header values including semicolon-separated session credentials", () => {
    const text = "Cookie: session=PRIVATE_SESSION; other=PRIVATE_OTHER\n" +
      "Set-Cookie: session=PRIVATE_SET; Secure; HttpOnly\n" +
      "Authorization: Basic PRIVATE_BASIC\nRequest headers Cookie: session=PRIVATE_EMBEDDED; other=PRIVATE_ALSO\nMCP error: invalid parameter";
    const safe = redactKlingCliText(text);
    expect(safe).not.toContain("PRIVATE_");
    expect(safe).toContain("MCP error: invalid parameter");
  });

  it("handles long slash-heavy output while preserving the final provider error", () => {
    const slashHeavy = "/path".repeat(80_000);
    const started = performance.now();
    const safe = redactKlingCliText(slashHeavy + "\nC:\\Users\\private name\\.credentials\nFINAL ERROR");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(safe).toContain(slashHeavy);
    expect(safe).toContain("FINAL ERROR");
    expect(safe).not.toContain("private name");
  });
});
