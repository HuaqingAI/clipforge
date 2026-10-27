import { createHash } from "node:crypto";
import type { Shot } from "@/lib/db/schema";

/** Persisted context is independent of the numeric shot index, which scripts may reuse. */
export interface AssetScope {
  sourceScriptId: string | null;
  sourceShotKey: string | null;
  sourceRevision: string | null;
  derivedFromAssetId?: string | null;
}

export interface ScriptContext {
  id: string;
  shots?: Shot[] | null;
  version?: number | null;
  characters?: unknown;
  totalDuration?: number | null;
  styleType?: string | null;
  copyDocument?: unknown;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Capture generation provenance without using it to invalidate same-script media. */
export function scriptRevision(script: ScriptContext): string {
  return digest({ id: script.id, version: script.version, shots: script.shots ?? [], characters: script.characters ?? [], totalDuration: script.totalDuration, styleType: script.styleType, ...(script.copyDocument != null && { copyDocument: script.copyDocument }) });
}

export function shotKey(scriptId: string, shot: Shot): string {
  return digest({ scriptId, shot });
}

export function assetScopeForShot(script: ScriptContext, shot: Shot, derivedFromAssetId?: string | null): AssetScope {
  return { sourceScriptId: script.id, sourceShotKey: shotKey(script.id, shot), sourceRevision: scriptRevision(script), ...(derivedFromAssetId !== undefined && { derivedFromAssetId }) };
}

export function assetMatchesScript(row: { shotId: number } & Partial<AssetScope>, script: ScriptContext | undefined | null): boolean {
  // Canonical TIDEWE scripts require explicit provenance even for historical media.
  if (row.sourceScriptId == null && row.sourceShotKey == null && row.sourceRevision == null) {
    return script?.styleType !== "tidewe_outdoor" && script?.copyDocument == null;
  }
  // A saved alternative owns its media by script ID and shot ID. Revision hashes
  // remain audit metadata; edits within that alternative must not strand its takes.
  if (!script || !row.sourceScriptId || row.sourceScriptId !== script.id) return false;
  return Boolean(script.shots?.some((item) => item.shotId === row.shotId));
}

export function filterAssetsForScript<T extends { shotId: number } & Partial<AssetScope>>(rows: T[], script: ScriptContext | undefined | null): T[] {
  return rows.filter((row) => assetMatchesScript(row, script));
}
