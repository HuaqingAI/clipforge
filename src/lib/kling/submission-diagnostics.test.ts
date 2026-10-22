// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KlingError } from "./errors";
import { classifyKlingSubmissionFailure, createKlingSubmissionDiagnostics } from "./submission-diagnostics";
import type { KlingCliResult } from "./types";

const cli = (overrides: Partial<KlingCliResult> = {}): KlingCliResult => ({ exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, ...overrides });
const rejected = { ok: true, status: 200, body: { status: 500, result: 1, data: null, error: { type: "AGENT.UnsupportedFileType", detail: "Untrusted provider text" } } };
const upload = (body: unknown = rejected) => cli({ stderr: `[kling] Uploading local file: C:\\private\\image.webp\nFailed to upload C:\\private\\image.webp: ${JSON.stringify(body)}\n` });
const unknownParameter = "Unknown parameter --sound. Model kling-video-v4_0 declares these generation parameters: duration, mode (flags may use snake_case or camelCase; run kling who_am_i for the full spec).";

describe("Kling submission failure evidence", () => {
  it.each([
    ["unsupported upload", upload(), "KLING_INPUT_FORMAT_UNSUPPORTED", "upload"],
    ["unknown upload rejection", upload({ ok: false, status: 500, body: { error: { type: "AGENT.UnknownError" } } }), "KLING_UPLOAD_FAILED", "upload"],
    ["missing upload URL", upload({ ok: true, status: 200, body: { uploaded: true } }), "KLING_UPLOAD_FAILED", "upload"],
    ["upload network error", cli({ stderr: "File upload failed (https://private.test/upload?token=secret): fetch failed\n" }), "KLING_UPLOAD_FAILED", "upload"],
    ["upload ticket malformed", cli({ stderr: 'file_upload ticket response is missing ticket/uploadUrl: {"secret":"x"}\n' }), "KLING_UPLOAD_FAILED", "upload"],
    ["upload MCP call error", cli({ stderr: "MCP tool call failed (file_upload): connection lost\n" }), "KLING_UPLOAD_FAILED", "upload"],
    ["after-upload parameter validation", cli({ stderr: `[kling] Uploaded -> https://signed.test/image?token=secret\n${unknownParameter}\n` }), "KLING_SUBMISSION_VALIDATION_FAILED", "validation"],
    ["Chinese parameter validation", cli({ stderr: "未知参数 --sound。模型 kling-video-v4_0 声明的生成参数：duration, mode（flag 用 snake_case 或 camelCase 均可，规格详见 kling who_am_i）\n" }), "KLING_SUBMISSION_VALIDATION_FAILED", "validation"],
    ["required input validation", cli({ stderr: "Model kling-video requires at least 2 reference image(s) (required inputs: first_frame, last_frame), but only 1 were provided. Add them with --image (run kling who_am_i for the full spec).\n" }), "KLING_SUBMISSION_VALIDATION_FAILED", "validation"],
    ["model capability drift", cli({ stderr: 'Model "kling-video" is not available for image_to_video. Available models: kling-new\n' }), "KLING_MODEL_UNAVAILABLE", "validation"],
    ["capability discovery failed", cli({ stderr: 'Capability discovery (who_am_i) failed: {"error":"provider unavailable"}\n' }), "KLING_MODEL_UNAVAILABLE", "validation"],
    ["capability discovery network failure", cli({ stderr: "MCP tool call failed (who_am_i): fetch failed\n" }), "KLING_MODEL_UNAVAILABLE", "validation"],
    ["expired login", cli({ stderr: "Login has expired and no refresh token is available. Run again: kling login\n" }), "KLING_AUTH_REQUIRED", "startup"],
    ["explicit known generation rejection", cli({ json: { ...rejected, ok: false } }), "KLING_INPUT_FORMAT_UNSUPPORTED", "submission"],
    ["spawn failed", cli({ spawnFailed: true, exitCode: null }), "KLING_SPAWN_FAILED", "startup"],
  ] as const)("classifies %s as definitely not submitted", (_name, result, code, phase) => {
    expect(classifyKlingSubmissionFailure(result)).toMatchObject({ code });
    expect(createKlingSubmissionDiagnostics(result)).toMatchObject({ phase, outcome: "not_submitted", localCode: code });
  });

  it.each([
    ["generation network error", cli({ stderr: "MCP tool call failed (image_to_video): fetch failed\n" })],
    ["connection failure without proven phase", cli({ stderr: "MCP connection failed: fetch failed\n" })],
    ["generic authentication mention", cli({ stderr: "MCP tool call failed (image_to_video): HTTP 401 authentication failed\n" })],
    ["unknown platform error", cli({ json: { ok: false, status: 400, body: { result: 1, data: null, error: { type: "AGENT.UnknownError", detail: "AGENT.UnsupportedFileType" } } } })],
    ["platform internal error", cli({ json: { ok: false, status: 500, body: { code: "INTERNAL_SERVER_ERROR" } } })],
    ["generic MCP failure", cli({ json: { ok: false, status: 400, body: "unknown parameter" } })],
    ["successful envelope without ID", cli({ exitCode: 0, json: { ok: true, body: { accepted: true } } })],
    ["malformed upload payload", cli({ stderr: 'Failed to upload C:\\image.webp: {"body":\n' })],
    ["mentioned upload error", cli({ stderr: `MCP tool call failed (image_to_video): ${upload().stderr}` })],
    ["upload failure followed by other error", cli({ stderr: `${upload().stderr}Some other failure\n` })],
    ["validation after submit evidence", cli({ stderr: `[kling] Submit arguments: []\n${unknownParameter}\n` })],
    ["Chinese validation after submit evidence", cli({ stderr: `[kling] 提交 arguments：[]\n${unknownParameter}\n` })],
    ["contradictory JSON and terminal validation", cli({ json: { ok: false, body: { unknown: true } }, stderr: unknownParameter })],
    ["signalled upload", { ...upload(), signal: "SIGTERM" }],
    ["timed out upload", { ...upload(), timedOut: true }],
    ["cancelled upload", { ...upload(), aborted: true }],
  ] as const)("keeps %s unknown", (_name, result) => {
    expect(classifyKlingSubmissionFailure(result)).toBeUndefined();
    expect(createKlingSubmissionDiagnostics(result)).toMatchObject({ outcome: "unknown" });
  });

  it.each([
    cli({ ...upload(), generationId: "task-id" }),
    cli({ ...upload(), json: { ok: false, body: { generation_id: "task-id" } } }),
    cli({ ...upload(), stdout: '{"ok":true,"body":{"generationId":"task-id"}}\n' }),
    cli({ spawnFailed: true, generationId: "task-id" }),
  ])("gives acknowledged IDs priority over every failure signal", (result) => {
    expect(classifyKlingSubmissionFailure(result)).toBeUndefined();
    expect(createKlingSubmissionDiagnostics(result)).toBeUndefined();
  });

  it("uses an error's attached result without trusting arbitrary error messages", () => {
    const error = new KlingError("KLING_CLI_FAILED", "https://private.test?token=secret", 502, upload());
    expect(classifyKlingSubmissionFailure(undefined, error)?.code).toBe("KLING_INPUT_FORMAT_UNSUPPORTED");
    expect(classifyKlingSubmissionFailure(undefined, new Error(unknownParameter))).toBeUndefined();
    const local = new KlingError("KLING_ENVIRONMENT_CHANGED", "untrusted local path C:\\private\\credentials");
    expect(classifyKlingSubmissionFailure(cli({ spawnFailed: true }), local)).toMatchObject({ code: "KLING_ENVIRONMENT_CHANGED" });
    expect(createKlingSubmissionDiagnostics(cli({ spawnFailed: true }), local)?.reason).not.toContain("private");
  });

  it("ignores only the pinned CLI upgrade notice after a terminal upload error", () => {
    const result = upload();
    result.stderr += "[kling] New version 0.3.0 found (current 0.2.0). Upgrade and try again: npm install -g @klingai/cli-global\n";
    expect(classifyKlingSubmissionFailure(result)?.code).toBe("KLING_INPUT_FORMAT_UNSUPPORTED");
  });

  it("produces a safe fixed summary without credentials, URLs, local paths or arbitrary text", () => {
    const result = upload({ ok: false, status: 403, body: { error: { type: "SECRET-CODE", detail: "https://secret.test?token=password C:\\private\\credentials" } } });
    const summary = createKlingSubmissionDiagnostics(result);
    expect(summary).toMatchObject({ phase: "upload", outcome: "not_submitted", httpStatus: 403, source: "platform" });
    const serialized = JSON.stringify(summary);
    for (const secret of ["https:", "token", "password", "private", "credentials", "SECRET-CODE"]) expect(serialized).not.toContain(secret);
    expect(classifyKlingSubmissionFailure(result)?.result).toBeUndefined();
  });
});
