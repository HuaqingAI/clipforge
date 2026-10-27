import type { TidewePresenterSnapshot } from "./types";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function reference(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 28_000_000) return false;
  if (/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)) return true;
  if (/^\/api\/files\/[^?#]+(?:\?[^#]*)?$/.test(value)) {
    try { return !decodeURIComponent(value.split("?")[0]).split(/[\\/]/).some(segment => segment === ".." || segment === "."); }
    catch { return false; }
  }
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function references(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(reference).map(url => url.trim()))].slice(0, 8) : [];
}

/** Request validation is strict; canonicalization alone must not silently discard malformed identity data. */
export function isValidTidewePresenterInput(value: unknown): boolean {
  if (!record(value)) return false;
  for (const [key, max, required] of [["id", 128, true], ["name", 120, true], ["appearance", 2400, false], ["description", 600, false]] as const) {
    const field = value[key];
    if (field === undefined && !required) continue;
    if (typeof field !== "string" || field.length > max || (required && !field.trim())) return false;
  }
  for (const key of ["referenceImages", "sourceReferenceImages"] as const) {
    const field = value[key];
    if (field !== undefined && (!Array.isArray(field) || field.length > 8 || !field.every(reference))) return false;
  }
  return Boolean(snapshotTidewePresenter(value));
}

/** Shared by browser selection and persisted profile canonicalization. */
export function snapshotTidewePresenter(value: unknown): TidewePresenterSnapshot | undefined {
  if (!record(value)) return undefined;
  const id = text(value.id, 128);
  const name = text(value.name, 120);
  if (!id || !name) return undefined;
  const appearance = text(value.appearance, 2400);
  const referenceImages = references(value.referenceImages);
  const sourceReferenceImages = references(value.sourceReferenceImages);
  if (!appearance && !referenceImages.length && !sourceReferenceImages.length) return undefined;
  const description = text(value.description, 600);
  return { id, name, appearance, ...(description && { description }), referenceImages,
    ...(sourceReferenceImages.length && { sourceReferenceImages }) };
}

/** The sheet is preferred; an uploaded portrait already anchors identity without a paid sheet step. */
export function tidewePresenterReference(profile: unknown): string | undefined {
  const presenter = record(profile) ? snapshotTidewePresenter(profile.presenter) : undefined;
  return presenter?.referenceImages[0] ?? presenter?.sourceReferenceImages?.[0];
}

/** No image bytes or speculative physical traits belong in the language-model input. */
export function tidewePresenterForPrompt(presenter?: TidewePresenterSnapshot) {
  return presenter ? { id: presenter.id, name: presenter.name, appearance: presenter.appearance,
    hasReferenceImage: Boolean(presenter.referenceImages.length || presenter.sourceReferenceImages?.length) } : undefined;
}

export const TIDEWE_PRESENTER_PLACEHOLDER = "{{PRESENTER}}";

export function tidewePresenterAnchor(presenter: TidewePresenterSnapshot): string {
  return `所选主播 ${presenter.name}（${presenter.appearance || "外貌以所选主播参考图为准"}）`;
}
