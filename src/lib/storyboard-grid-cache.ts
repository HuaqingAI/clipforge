import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { join, sep } from "path";
import { getDataDir } from "@/lib/paths";
import { resolveUploadFilePath } from "@/lib/remote-image";
import type { StoryboardGridResolutionInfo } from "@/lib/storyboard-grid-resolution";

export const STORYBOARD_GRID_CROP_VERSION = 2;

export interface StoryboardGridCell {
  shotId: number;
  filePath: string;
}

export interface StoryboardGridManifest {
  version: typeof STORYBOARD_GRID_CROP_VERSION;
  signature: string;
  gridPath: string;
  cells: StoryboardGridCell[];
  resolution?: StoryboardGridResolutionInfo;
}

interface SelectedAsset {
  shotId: number;
  filePath?: string | null;
  selected?: boolean | null;
  status?: string | null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

/** Only the digest is persisted; the caller excludes credentials from this input. */
export function storyboardGridSignature(input: {
  scriptId: string;
  shots: unknown;
  characters: unknown;
  prompt: string;
  referenceInputs: string[];
  referenceContents: string[];
  provider: string;
  model: string;
  baseUrl: string;
  options: Record<string, unknown>;
}): string {
  return createHash("sha256").update(JSON.stringify(stableValue({
    cropVersion: STORYBOARD_GRID_CROP_VERSION,
    input,
  }))).digest("hex");
}

function manifestPath(projectId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error("Invalid grid cache project id");
  return join(getDataDir(), "storyboard-grids", `${projectId}.json`);
}

/** Write only after every cell was cropped and made active; replace atomically on completion. */
export async function saveStoryboardGridManifest(projectId: string, manifest: StoryboardGridManifest): Promise<void> {
  const target = manifestPath(projectId);
  await mkdir(join(getDataDir(), "storyboard-grids"), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), "utf8");
  await rename(temporary, target);
}

async function existingProjectImage(projectId: string, publicPath: unknown): Promise<boolean> {
  if (typeof publicPath !== "string" || !publicPath.startsWith(`/api/files/${projectId}/`)) return false;
  const path = resolveUploadFilePath(publicPath);
  const projectRoot = join(getDataDir(), "uploads", projectId);
  if (!path || !path.startsWith(projectRoot + sep)) return false;
  try {
    const file = await stat(path);
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

/** Missing/older/changed caches are a normal miss; never infer provenance from legacy asset text. */
export async function reusableStoryboardGrid(
  projectId: string,
  signature: string,
  shotIds: number[],
  selectedAssets: SelectedAsset[],
): Promise<StoryboardGridManifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath(projectId), "utf8")) as StoryboardGridManifest;
    if (manifest.version !== STORYBOARD_GRID_CROP_VERSION || manifest.signature !== signature || !Array.isArray(manifest.cells)
      || manifest.cells.length !== shotIds.length || !await existingProjectImage(projectId, manifest.gridPath)) return;
    for (let i = 0; i < shotIds.length; i++) {
      const cell = manifest.cells[i];
      if (!cell || cell.shotId !== shotIds[i]) return;
      const active = selectedAssets.filter((asset) => asset.shotId === cell.shotId && asset.selected === true);
      if (active.length !== 1 || active[0].status !== "done" || active[0].filePath !== cell.filePath
        || !await existingProjectImage(projectId, cell.filePath)) return;
    }
    return manifest;
  } catch {
    return undefined;
  }
}
