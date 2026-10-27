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

/** Changes to selection timestamps do not invalidate a script; changes to its content do. */
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
  // The revision records generation provenance. An edit to a sibling shot must not
  // invalidate this shot's unchanged media, while partially scoped rows stay invalid.
  if (!script || !row.sourceScriptId || !row.sourceShotKey || !row.sourceRevision || row.sourceScriptId !== script.id) return false;
  const shot = script.shots?.find((item) => item.shotId === row.shotId);
  return Boolean(shot && row.sourceShotKey === shotKey(script.id, shot));
}

export function filterAssetsForScript<T extends { shotId: number } & Partial<AssetScope>>(rows: T[], script: ScriptContext | undefined | null): T[] {
  return rows.filter((row) => assetMatchesScript(row, script));
}
