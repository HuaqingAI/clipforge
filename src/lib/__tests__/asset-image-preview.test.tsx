import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShotMaterialPreview } from "@/app/project/[id]/assets/_components/shot-material-preview";
import { AssetImagePreview } from "@/app/project/[id]/assets/_components/asset-image-preview";
import type { AssetItem } from "@/lib/assets-view";

vi.mock("@/lib/i18n", () => ({ useT: () => (key: string) => key }));

let root: Root;
let container: HTMLDivElement;
const source = "/api/files/project/shot-2-original.png";
const poster = "/api/files/project/shot-2.mp4.thumb.jpg";
const video = "/api/files/project/shot-2.mp4";
const asset: AssetItem = {
  shotId: 2, type: "demo", duration: 6, description: "Sofa armrest", prompt: "Close-up",
  visualSource: "ai_generate", status: "done", thumbnailUrl: source,
};

function dialog() { return document.querySelector('[role="dialog"]'); }
async function openPreview() {
  await act(async () => (container.querySelector('[aria-label="viewOriginalImage"]') as HTMLButtonElement).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("asset original image preview", () => {
  it.each([false, true])("opens the complete original still for an image/video source (video: %s) and closes it", async (isVideo) => {
    await act(async () => root.render(<ShotMaterialPreview asset={{ ...asset, isVideo, thumbnailUrl: isVideo ? poster : source, sourceImageUrl: isVideo ? source : undefined, videoUrl: isVideo ? video : undefined }} />));
    expect(dialog()).toBeNull();
    await openPreview();
    const popup = dialog()!;
    expect(popup).not.toBeNull();
    expect(popup.getAttribute("aria-labelledby")).toBeTruthy();
    const image = popup.querySelector("img")!;
    expect(image.src).toBe(new URL(source, window.location.href).href);
    expect(image.getAttribute("srcset")).toBeNull();
    expect(image.className).toContain("object-contain");
    expect(popup.querySelector("video")).toBeNull();
    expect(popup.querySelector('[role="status"]')?.textContent).toBe("imagePreviewLoading");
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(popup.querySelector('[role="status"]')).toBeNull();
    await act(async () => (popup.querySelector('[aria-label="closeImagePreview"]') as HTMLButtonElement).click());
    expect(dialog()).toBeNull();
  });

  it("closes with Escape and returns focus to the clicked image", async () => {
    await act(async () => root.render(<ShotMaterialPreview asset={asset} />));
    const trigger = container.querySelector('[aria-label="viewOriginalImage"]') as HTMLButtonElement;
    trigger.focus();
    await openPreview();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when clicking the backdrop", async () => {
    await act(async () => root.render(<ShotMaterialPreview asset={asset} />));
    await openPreview();
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("shows a load failure and retries the image when reopened", async () => {
    await act(async () => root.render(<ShotMaterialPreview asset={asset} />));
    await openPreview();
    await act(async () => dialog()!.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("sourceImageLoadFailed");
    expect(dialog()!.querySelector('[role="status"]')).toBeNull();
    await act(async () => (dialog()!.querySelector('[aria-label="closeImagePreview"]') as HTMLButtonElement).click());
    await openPreview();
    expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
    expect(dialog()!.querySelector("img")?.src).toBe(new URL(source, window.location.href).href);
  });

  it("supports compact image thumbnails without changing the source URL", async () => {
    await act(async () => root.render(<AssetImagePreview src={poster} alt="Generated poster" shotId={2}><span>Thumbnail</span></AssetImagePreview>));
    await openPreview();
    expect(dialog()!.querySelector("img")?.src).toBe(new URL(poster, window.location.href).href);
  });

  it("retains playable video controls when no original still is recorded", async () => {
    await act(async () => root.render(<ShotMaterialPreview asset={{ ...asset, isVideo: true, thumbnailUrl: poster, videoUrl: video }} />));
    expect(container.querySelector('[aria-label="viewOriginalImage"]')).toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(video);
    expect(container.querySelector("video")?.controls).toBe(true);
  });
});
