import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenterManager } from "@/components/presenter-manager";
import { useCharacterStore, type Character } from "@/lib/stores/project-store";
import { settings } from "@/lib/i18n/messages/settings";

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/gen-params", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/gen-params")>(),
  resolveDefaultModelTarget: async () => ({ provider: "openai", model: "gpt-image-2", apiKey: "test-key", baseUrl: "https://images.example/v1" }),
  buildImageOptions: () => ({ aspectRatio: "1:1", count: 1 }),
}));

const request = vi.fn();
let root: Root;
let container: HTMLDivElement;

function button(text: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!; }
function references() { return useCharacterStore.getState().characters[0]; }
function imageFile(name = "portrait.jpg", type = "image/jpeg") { return new File(["portrait"], name, { type }); }
function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function mount(characters: Character[] = []) {
  useCharacterStore.setState({ characters });
  await act(async () => root.render(<PresenterManager />));
}
async function startCreate(name = "Mei") {
  await act(async () => button("characterAddButton").click());
  await act(async () => inputValue(container.querySelector("#character-name")!, name));
}
async function upload(files: File[]) {
  const input = container.querySelector<HTMLInputElement>("#character-reference-images")!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function sheetRequests() { return request.mock.calls.filter(([url]) => url === "/api/characters/sheet").map(([, options]) => JSON.parse(options.body)); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", request);
  request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/upload") {
      const files = (init!.body as FormData).getAll("files") as File[];
      return Response.json({ paths: files.map((file) => `/api/files/characters/${file.name}`) });
    }
    if (url === "/api/characters/sheet") return Response.json({ url: "/api/files/characters/sheet.png" });
    throw new Error(`Unexpected request: ${url}`);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCharacterStore.setState({ characters: [] });
  vi.unstubAllGlobals();
});

describe("presenter reference photos", () => {
  it("saves multiple optional photos and sends every photo when manually generating a photo-only sheet", async () => {
    await mount();
    await startCreate();
    const input = container.querySelector<HTMLInputElement>("#character-reference-images")!;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
    await upload([imageFile("front.jpg"), imageFile("side.png", "image/png")]);
    expect(container.querySelectorAll('img[alt="characterReferenceAlt"]')).toHaveLength(2);
    const uploadBody = request.mock.calls[0][1].body as FormData;
    expect(uploadBody.get("projectId")).toBe("characters");
    expect(uploadBody.getAll("files")).toHaveLength(2);
    await act(async () => button("characterAddSubmit").click());
    const photos = ["/api/files/characters/front.jpg", "/api/files/characters/side.png"];
    expect(references()).toMatchObject({ name: "Mei", appearance: "", sourceReferenceImages: photos, referenceImages: [] });
    expect(sheetRequests()).toHaveLength(0);
    expect(button("characterSheetBtn")).toBeTruthy();
    expect(container.querySelector('img[alt="characterReferenceAlt"]')?.getAttribute("src")).toBe(photos[0]);
    await act(async () => button("characterSheetBtn").click());
    expect(sheetRequests()).toEqual([expect.objectContaining({ appearance: "", name: "Mei", referenceImageUrls: photos })]);
    expect(references().referenceImages).toEqual(["/api/files/characters/sheet.png"]);
    expect(references().sourceReferenceImages).toEqual(photos);
  });

  it("retains photos on edit, preserves an unchanged sheet, and clears it after removing and adding photos", async () => {
    await mount([{ id: "mei", name: "Mei", referenceImages: ["/old-sheet.png"], sourceReferenceImages: ["/front.jpg", "/side.jpg"] }]);
    await act(async () => button("characterEdit").click());
    expect(container.querySelectorAll('button[aria-label="characterReferenceRemove"]')).toHaveLength(2);
    expect(button("characterSheetRedo").disabled).toBe(true);
    await act(async () => button("characterSaveEdit").click());
    expect(references().referenceImages).toEqual(["/old-sheet.png"]);

    await act(async () => button("characterEdit").click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="characterReferenceRemove"]')!.click());
    await upload([imageFile("new-angle.webp", "image/webp")]);
    await act(async () => button("characterSaveEdit").click());
    expect(references().sourceReferenceImages).toEqual(["/side.jpg", "/api/files/characters/new-angle.webp"]);
    expect(references().referenceImages).toEqual([]);
    await act(async () => button("characterSheetBtn").click());
    expect(sheetRequests()[0].referenceImageUrls).toEqual(["/side.jpg", "/api/files/characters/new-angle.webp"]);
  });

  it("supports no uploads and the existing appearance-only generation flow", async () => {
    await mount();
    await startCreate();
    await act(async () => inputValue(container.querySelector("textarea")!, "A presenter with short black hair"));
    await act(async () => button("characterAddSubmit").click());
    expect(references().sourceReferenceImages).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await act(async () => button("characterSheetBtn").click());
    expect(sheetRequests()).toEqual([expect.objectContaining({ appearance: "A presenter with short black hair", referenceImageUrls: [] })]);
  });

  it("allows removing all photos and requires an appearance before generating without them", async () => {
    await mount([{ id: "mei", name: "Mei", referenceImages: ["/old-sheet.png"], sourceReferenceImages: ["/front.jpg"] }]);
    await act(async () => button("characterEdit").click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="characterReferenceRemove"]')!.click());
    await act(async () => button("characterSaveEdit").click());
    expect(references().sourceReferenceImages).toEqual([]);
    expect(references().referenceImages).toEqual([]);
    await act(async () => button("characterSheetBtn").click());
    expect(container.textContent).toContain("characterSheetNeedsAppearance");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps save blocked after a failed upload until a successful retry", async () => {
    await mount();
    await startCreate();
    request.mockResolvedValueOnce(Response.json({ error: "Upload unavailable" }, { status: 503 }));
    await upload([imageFile("front.jpg"), imageFile("side.jpg")]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Upload unavailable");
    expect(button("characterAddSubmit").disabled).toBe(true);
    await act(async () => button("characterAddSubmit").click());
    expect(useCharacterStore.getState().characters).toEqual([]);
    await act(async () => button("characterReferenceRetry").click());
    expect(button("characterAddSubmit").disabled).toBe(false);
    await act(async () => button("characterAddSubmit").click());
    expect(references().sourceReferenceImages).toHaveLength(2);
  });

  it("treats incomplete upload responses as failures and allows explicitly discarding them", async () => {
    await mount();
    await startCreate();
    request.mockResolvedValueOnce(Response.json({ paths: ["/front.jpg"] }));
    await upload([imageFile("front.jpg"), imageFile("side.jpg")]);
    expect(button("characterAddSubmit").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("characterReferenceUploadFailed");
    expect(container.querySelectorAll('img[alt="characterReferenceAlt"]')).toHaveLength(0);
    await act(async () => button("characterReferenceDiscard").click());
    await act(async () => button("characterAddSubmit").click());
    expect(references().sourceReferenceImages).toEqual([]);
  });

  it("blocks saving during upload and ignores late results after cancel and reopening", async () => {
    await mount();
    await startCreate();
    let finishUpload!: (res: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishUpload = resolve; }));
    await upload([imageFile()]);
    const signal = request.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(button("characterAddSubmit").disabled).toBe(true);
    await act(async () => button("characterCancel").click());
    expect(signal.aborted).toBe(true);
    await startCreate("Different presenter");
    await act(async () => finishUpload(Response.json({ paths: ["/late.jpg"] })));
    expect(container.querySelectorAll('img[alt="characterReferenceAlt"]')).toHaveLength(0);
    await act(async () => button("characterAddSubmit").click());
    expect(references()).toMatchObject({ name: "Different presenter", sourceReferenceImages: [] });
  });

  it("ignores an old upload when switching from creating to editing another presenter", async () => {
    await mount([{ id: "saved", name: "Saved", sourceReferenceImages: ["/saved.jpg"], referenceImages: [] }]);
    await startCreate();
    let finishUpload!: (res: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishUpload = resolve; }));
    await upload([imageFile()]);
    await act(async () => button("characterEdit").click());
    expect((request.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    await act(async () => finishUpload(Response.json({ paths: ["/late.jpg"] })));
    await act(async () => button("characterSaveEdit").click());
    expect(references().sourceReferenceImages).toEqual(["/saved.jpg"]);
    expect(useCharacterStore.getState().characters).toHaveLength(1);
  });

  it.each(["count", "type", "size"])("rejects invalid photo %s before uploading and blocks save until acknowledged", async (kind) => {
    await mount();
    await startCreate();
    const file = imageFile();
    if (kind === "size") Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 + 1 });
    const files = kind === "count" ? Array.from({ length: 9 }, () => imageFile()) : kind === "type" ? [imageFile("portrait.gif", "image/gif")] : [file];
    await upload(files);
    expect(request).not.toHaveBeenCalled();
    expect(button("characterAddSubmit").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    await act(async () => button("characterReferenceDiscard").click());
    expect(button("characterAddSubmit").disabled).toBe(false);
  });

  it("locks edit and delete during sheet generation", async () => {
    await mount([{ id: "mei", name: "Mei", referenceImages: [], sourceReferenceImages: ["/front.jpg"] }]);
    let finishSheet!: (res: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSheet = resolve; }));
    await act(async () => button("characterSheetBtn").click());
    expect(button("characterEdit").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="characterDelete"]')!.disabled).toBe(true);
    await act(async () => finishSheet(Response.json({ url: "/sheet.png" })));
    expect(button("characterEdit").disabled).toBe(false);
    expect(references().referenceImages).toEqual(["/sheet.png"]);
  });

  it.each(["updated", "removed"])("does not save a late sheet after the presenter is %s elsewhere", async (change) => {
    await mount([{ id: "mei", name: "Mei", referenceImages: [], sourceReferenceImages: ["/front.jpg"] }]);
    let finishSheet!: (res: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSheet = resolve; }));
    await act(async () => button("characterSheetBtn").click());
    await act(async () => {
      if (change === "updated") useCharacterStore.getState().updateCharacter("mei", { sourceReferenceImages: ["/different-person.jpg"], referenceImages: [] });
      else useCharacterStore.getState().removeCharacter("mei");
    });
    await act(async () => finishSheet(Response.json({ url: "/obsolete-sheet.png" })));
    expect(references()?.referenceImages ?? []).toEqual([]);
    if (change === "updated") expect(references().sourceReferenceImages).toEqual(["/different-person.jpg"]);
    else expect(useCharacterStore.getState().characters).toHaveLength(0);
    expect(container.textContent).toContain("characterSheetInputChanged");
    expect(container.textContent).not.toContain("characterSheetDone");
  });

  it("provides photo controls and errors in both languages", () => {
    const keys = ["characterReferenceLabel", "characterReferenceTip", "characterReferenceUpload", "characterReferenceUploading", "characterReferenceSaved", "characterReferenceAlt", "characterReferenceRemove", "characterReferenceLimit", "characterReferenceTypeError", "characterReferenceSizeError", "characterReferenceUploadFailed", "characterReferenceRetry", "characterReferenceDiscard", "characterDelete", "characterSheetInputChanged"];
    for (const key of keys) {
      expect(settings.zh[key]).toBeTruthy();
      expect(settings.en[key]).toBeTruthy();
      expect(/[\u4e00-\u9fff]/.test(String(settings.en[key]))).toBe(false);
    }
  });
});
