import { createHash } from "node:crypto";
import { KlingError } from "./errors";
import { KLING_ADAPTER_VERSION, KLING_PACKAGE, KLING_VERSION } from "./types";
import type { KlingVideoModelDescriptor, KlingParameter, KlingInputSlot, KlingNormalizedTask, KlingAccountSummary, KlingTool } from "./types";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function unwrapKlingBody(value: unknown): Record<string, unknown> {
  const outer = record(value);
  if (outer.ok === false) throw new KlingError("KLING_REMOTE_ERROR", "Kling 返回操作失败，请检查账号状态。", 502);
  return record(Object.hasOwn(outer, "body") ? outer.body : outer);
}
export function parseCliJson(stdout: string): unknown | undefined {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* CLI diagnostics may surround one JSON line. */ }
  for (const line of text.split(/\r?\n/).reverse()) {
    try { const value: unknown = JSON.parse(line); if (value && typeof value === "object") return value; } catch { /* skip diagnostics */ }
  }
  return undefined;
}
export function extractGenerationId(value: unknown): string | undefined {
  const outer = record(value);
  const body = record(Object.hasOwn(outer, "body") ? outer.body : outer);
  const id = body.generationId ?? body.generation_id;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id) ? id : undefined;
}
export function modelSelectionKey(tool: KlingTool, remoteModelId: string): string {
  return JSON.stringify(["kling-cli", tool, remoteModelId]);
}
const RESERVED = new Set(["model", "prompt", "image", "tailImage", "poll", "quiet", "base-url", "task-trace-id"]);
const scalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

function capabilityRevision(models: KlingVideoModelDescriptor[]): string {
  const compare = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  // Tool argument/input order is not used when dispatching: flags are identified by name and
  // image slots by role/count. Catalog display order, aliases and prose may change independently.
  const capabilities = models.map((model) => ({ provider: model.provider, region: model.region, tool: model.tool,
    remoteModelId: model.remoteModelId, available: model.available, capabilities: model.capabilities,
    parameters: model.parameters.map((parameter) => ({ name: parameter.name, required: parameter.required, type: parameter.type,
      ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      ...(parameter.allowedValues ? { allowedValues: [...parameter.allowedValues].sort(compare) } : {}) })).sort(compare),
    inputSlots: model.inputSlots.map((slot) => ({ name: slot.name, role: slot.role, required: slot.required })).sort(compare),
  })).sort(compare);
  return createHash("sha256").update(JSON.stringify({ package: KLING_PACKAGE, cliVersion: KLING_VERSION,
    adapterVersion: KLING_ADAPTER_VERSION, models: capabilities })).digest("hex");
}

/** Catalog fields map CLI arguments; all Kling capabilities remain available for users to evaluate. */
export function parseCatalog(value: unknown, profileId: string): KlingVideoModelDescriptor[] {
  const body = unwrapKlingBody(value);
  const catalog = record(body.availableModels ?? body.available_models);
  const models: KlingVideoModelDescriptor[] = [];
  for (const tool of ["text_to_video", "image_to_video"] as const) {
    const entry = catalog[tool];
    const list = Array.isArray(entry) ? entry : record(entry).models;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const raw = record(item);
      if (typeof raw.model !== "string" || !raw.model.trim() || raw.model.length > 256 || /[\x00-\x1f]/.test(raw.model)) continue;
      const parameters: KlingParameter[] = [];
      for (const arg of Array.isArray(raw.arguments) ? raw.arguments : []) {
        const a = record(arg); const name = typeof a.name === "string" ? a.name : "";
        if (RESERVED.has(name) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue;
        const allowed = a.allowedValues ?? a.allowed_values;
        const values = Array.isArray(allowed) && allowed.length && allowed.every(scalar) ? allowed : undefined;
        const defaultValue = scalar(a.default) ? a.default : undefined;
        const sample = values?.[0] ?? defaultValue;
        let type: KlingParameter["type"] = typeof sample === "boolean" ? "boolean" : typeof sample === "number" ? "number" : "string";
        if (a.type === "number" || a.type === "integer") type = "number";
        if (a.type === "boolean") type = "boolean";
        if (a.type && !["string", "number", "integer", "boolean"].includes(String(a.type))) continue;
        if (Array.isArray(allowed) && allowed.length && !values) continue;
        parameters.push({ name, required: a.required === true, type, ...(values ? { allowedValues: values } : {}), ...(defaultValue !== undefined ? { default: defaultValue } : {}), ...(typeof a.description === "string" ? { description: a.description.slice(0, 1000) } : {}) });
      }
      const inputSlots: KlingInputSlot[] = [];
      for (const input of Array.isArray(raw.inputs) ? raw.inputs : []) {
        const i = record(input); const name = typeof i.name === "string" ? i.name : "";
        const key = name.replace(/[_\s-]/g, "").toLowerCase();
        let role: KlingInputSlot["role"] | undefined;
        if (["image", "imageurl", "referenceimage", "reference", "firstimage", "firstframe", "startimage", "startframe"].includes(key)) role = "image";
        if (["tailimage", "tailframe", "lastimage", "lastframe", "endimage", "endframe"].includes(key)) role = "tailImage";
        if (!role) continue;
        inputSlots.push({ name, required: i.required === true, role });
      }
      // Preserve the command's first-image field when catalog display metadata omits it.
      if (tool === "image_to_video" && !inputSlots.some((s) => s.role === "image")) inputSlots.unshift({ name: "image", required: true, role: "image" });
      models.push({ selectionKey: modelSelectionKey(tool, raw.model), provider: "kling-cli", profileId, region: "global", tool,
        remoteModelId: raw.model, displayName: typeof raw.alias === "string" && raw.alias.trim() ? raw.alias : raw.model,
        ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 2000) } : {}),
        catalogRevision: "", available: true, parameters, inputSlots,
        capabilities: { image: true, tailFrame: true, multiImage: true, audio: true } });
    }
  }
  const revision = capabilityRevision(models);
  return models.map((m) => ({ ...m, catalogRevision: revision }));
}

export function extractPrincipal(value: unknown): { principalKey: string; accountSummary: KlingAccountSummary } {
  const body = unwrapKlingBody(value);
  const user = record(body.user ?? body.identity ?? body.account);
  // Do not use nickname, email, a generic response id, balance, or a token as account ownership.
  const id = body.userId ?? body.user_id ?? user.userId ?? user.user_id ?? user.id;
  if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim() || String(id).length > 256) throw new KlingError("KLING_PRINCIPAL_UNVERIFIED", "Kling 未返回可核验的稳定账号 ID，暂不能生成或恢复任务。", 409);
  const display = body.displayName ?? body.nickname ?? user.displayName ?? user.nickname ?? user.name;
  return { principalKey: JSON.stringify(["global", String(id)]), accountSummary: { id: String(id), ...(typeof display === "string" ? { displayName: display.slice(0, 120) } : {}) } };
}
export function normalizeKlingTask(value: unknown): KlingNormalizedTask {
  const body = unwrapKlingBody(value);
  const rawStatus = String(body.status ?? "unknown").toLowerCase();
  const success = new Set(["succeed", "succeeded", "success", "completed", "partial_completed"]);
  const failure = new Set(["fail", "failed", "error", "cancelled", "canceled", "rejected"]);
  const status: KlingNormalizedTask["status"] = success.has(rawStatus) ? "succeeded" : failure.has(rawStatus) ? "failed" : ["processing", "running", "generating", "in_progress"].includes(rawStatus) ? "processing" : ["pending", "queued", "submitted", "created", "waiting"].includes(rawStatus) ? "pending" : "unknown";
  const works: KlingNormalizedTask["works"] = [];
  for (const item of (Array.isArray(body.works) ? body.works : [])) {
    const work = record(item); const url = typeof work.url === "string" ? work.url : undefined;
    const mediaType = String(work.type ?? work.mediaType ?? work.media_type ?? work.resourceType ?? "").toLowerCase();
    if (/image|audio|photo|picture/.test(mediaType)) continue;
    const clean = typeof work.url_without_watermark === "string" ? work.url_without_watermark : typeof work.urlWithoutWatermark === "string" ? work.urlWithoutWatermark : undefined;
    const valid = (v: string | undefined) => { try { return !!v && new URL(v).protocol === "https:"; } catch { return false; } };
    if (!valid(url) && !valid(clean)) continue;
    let id = work.id ?? work.workId ?? work.work_id;
    if (typeof id !== "string" && typeof id !== "number") {
      const stable = new URL(valid(clean) ? clean! : url!);
      if (!stable.pathname || stable.pathname === "/") throw new KlingError("KLING_OUTPUT_ID_UNVERIFIED", "Kling 视频缺少稳定作品 ID，暂无法安全自动入库。", 409);
      id = "url:" + createHash("sha256").update(stable.origin + stable.pathname).digest("hex");
    }
    works.push({ id: String(id), url: valid(url) ? url! : clean!, ...(valid(clean) ? { watermarkFreeUrl: clean } : {}) });
  }
  const error = body.error_message ?? body.errorMessage ?? body.message;
  return { generationId: extractGenerationId(value), status, rawStatus, works, ...(typeof error === "string" && status === "failed" ? { error: "Kling 云端生成失败，请检查原任务和输入内容。" } : {}) };
}
