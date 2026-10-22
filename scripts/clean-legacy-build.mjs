// Remove output from the short-lived `.next-local` layout used by an older
// launcher. Keeping this cleanup in `prebuild` makes a normal `pnpm build`
// enough to migrate an existing checkout without touching source or data.
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const legacyBuilds = [
  join(root, ".next-local"),
  join(root, ".next", "standalone", ".next-local"),
];

for (const directory of legacyBuilds) {
  if (!existsSync(directory)) continue;
  rmSync(directory, { recursive: true, force: true });
  console.log(`Removed legacy build output: ${directory}`);
}
