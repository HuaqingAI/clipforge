import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export const ALIGNMENT_SPEC = JSON.parse(readFileSync(new URL("../alignment/runtime-spec.json", import.meta.url), "utf8"));

export function alignmentPaths(root, env = process.env) {
  const runtime = resolve(root, env.APP_ALIGNMENT_RUNTIME_DIR || ALIGNMENT_SPEC.runtimeRelativePath);
  return {
    runtime,
    python: join(runtime, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    model: join(runtime, "model"),
    ready: join(runtime, "ready.json"),
    checker: join(root, "scripts", "alignment", "check-runtime.py"),
  };
}

export function alignmentEnvironment(root, env = process.env) {
  return { ...env, APP_RESOURCE_DIR: resolve(root), APP_ALIGNMENT_RUNTIME_DIR: alignmentPaths(root, env).runtime };
}

export function probeAlignmentRuntime(root, env = process.env, { writeReady = false } = {}) {
  const paths = alignmentPaths(root, env);
  return spawnSync(paths.python, [paths.checker, "--runtime-dir", paths.runtime, ...(writeReady ? ["--write-ready"] : [])], {
    cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
}
