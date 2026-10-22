// Record the build produced by a manual `pnpm build` so start.cmd can reuse it.
// The launcher uses the same source fingerprint and BUILD_ID when deciding
// whether a rebuild is necessary.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInputPaths, fingerprint, ROOT } from "./launch-local.mjs";
import { localBuildStatus } from "./lib/local-build.mjs";

const status = localBuildStatus(ROOT, ".next");
if (!status.ok || !status.buildId) {
  throw new Error(`无法记录构建标记：.next 产物不完整${status.missing.length ? `（缺少 ${status.missing.slice(0, 8).join(", ")}）` : ""}`);
}

const directory = join(ROOT, ".clipforge");
mkdirSync(directory, { recursive: true });
const target = join(directory, "build.json");
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify({ fingerprint: fingerprint(ROOT, buildInputPaths(ROOT)), buildId: status.buildId }, null, 2));
renameSync(temporary, target);
console.log(`Recorded build ${status.buildId} for start.cmd reuse.`);
