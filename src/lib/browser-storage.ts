import type { StateStorage } from "zustand/middleware";

export interface ClipForgeStorage extends StateStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
  keys(): string[];
}

declare global {
  interface Window {
    clipforge?: { storage: ClipForgeStorage };
  }
}

export function isAppStorageKey(key: string): boolean {
  return /^(?:daihuo-jianshou-(?:settings|brand|characters|templates|products)|clipforge[_:-][\w:.-]+)$/.test(key);
}

/** Resolve at each call: Electron preload storage survives changes to the HTTP port. */
export const appStorage: ClipForgeStorage = {
  getItem(key) {
    if (typeof window === "undefined") return null;
    return window.clipforge?.storage ? window.clipforge.storage.getItem(key) : window.localStorage.getItem(key);
  },
  setItem(key, value) {
    if (typeof window === "undefined") return;
    if (window.clipforge?.storage) window.clipforge.storage.setItem(key, value);
    else window.localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (typeof window === "undefined") return;
    if (window.clipforge?.storage) window.clipforge.storage.removeItem(key);
    else window.localStorage.removeItem(key);
  },
  keys() {
    if (typeof window === "undefined") return [];
    const keys = window.clipforge?.storage ? window.clipforge.storage.keys() : Object.keys(window.localStorage);
    return keys.filter(isAppStorageKey);
  },
};

export interface ConfigurationTransfer {
  format: "clipforge-settings";
  schemaVersion: 1;
  exportedAt: string;
  includesSecrets: boolean;
  entries: Record<string, string>;
}

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api.?key|token|secret|password)/i.test(key) ? "" : withoutSecrets(item)]));
}

export function exportConfiguration(includeSecrets = false): ConfigurationTransfer {
  const entries: Record<string, string> = {};
  for (const key of appStorage.keys()) {
    const value = appStorage.getItem(key);
    if (value === null) continue;
    if (includeSecrets) entries[key] = value;
    else {
      try { entries[key] = JSON.stringify(withoutSecrets(JSON.parse(value))); }
      catch { entries[key] = value; }
    }
  }
  return { format: "clipforge-settings", schemaVersion: 1, exportedAt: new Date().toISOString(), includesSecrets: includeSecrets, entries };
}

/** Validate every entry before writing; never import arbitrary browser keys. */
export function importConfiguration(input: unknown): number {
  if (!input || typeof input !== "object") throw new Error("配置文件格式无效 / Invalid configuration file");
  const data = input as Partial<ConfigurationTransfer>;
  if (data.format !== "clipforge-settings" || data.schemaVersion !== 1 || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) {
    throw new Error("配置文件格式不受支持 / Unsupported configuration file");
  }
  const entries = Object.entries(data.entries);
  if (entries.length > 10000) throw new Error("配置条目过多 / Too many configuration entries");
  let bytes = 0;
  for (const [key, value] of entries) {
    if (!isAppStorageKey(key) || typeof value !== "string") throw new Error("配置包含无效条目 / Invalid configuration entry");
    bytes += key.length + value.length;
    if (bytes > 16 * 1024 * 1024) throw new Error("配置文件过大 / Configuration file is too large");
    if (key.startsWith("daihuo-jianshou-")) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { throw new Error("配置条目不是有效 JSON / Invalid configuration JSON"); }
      if (!decoded || typeof decoded !== "object" || !("state" in decoded) ||
        !decoded.state || typeof decoded.state !== "object" || Array.isArray(decoded.state)) {
        throw new Error("配置缺少有效状态 / Invalid persisted configuration state");
      }
    }
  }
  const previous = new Map(entries.map(([key]) => [key, appStorage.getItem(key)]));
  try { for (const [key, value] of entries) appStorage.setItem(key, value); }
  catch (error) {
    for (const [key, value] of previous) {
      try { if (value === null) appStorage.removeItem(key); else appStorage.setItem(key, value); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
  return entries.length;
}
