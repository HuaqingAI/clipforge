"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LuUpload, LuX, LuCircleAlert, LuZap, LuBox, LuEye } from "react-icons/lu";
import Link from "next/link";
import { useProductLibraryStore, type ProductItem } from "@/lib/stores/product-library-store";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { submitGenerationRun } from "@/lib/hooks/use-generation-runs";
import { createTideweOutdoorProfile, type TideweOutdoorProfile } from "@/lib/creative-profiles";
import { TideweProductFields, buildTideweProductFacts, type TideweProductInput } from "@/components/tidewe-product-fields";
import { TidewePresenterPicker } from "@/components/tidewe-presenter-picker";
import { TideweCopyInput, type TideweCopySource } from "@/components/tidewe-copy-input";
import { tideweCopyInputError } from "@/lib/tidewe/copy-input";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";

const durationOptions = [
  { value: "30", label: "30s" },
  { value: "40", label: "40s" },
  { value: "60", label: "60s" },
];
const videoModeOptions = [
  { value: "product_closeup", labelKey: "modeCloseupLabel", descKey: "modeCloseupDesc", icon: LuBox },
  { value: "scene_demo", labelKey: "modeSceneLabel", descKey: "modeSceneDesc", icon: LuEye },
] as const;

export default function NewProjectPage() {
  const router = useRouter();
  const pageAlive = useRef(false);
  useEffect(() => { pageAlive.current = true; return () => { pageAlive.current = false; }; }, []);
  const t = useT("newProject");
  const tt = useT("tidewe");
  const { llm } = useSettingsStore();
  const isLLMConfigured = llm.apiKey.length > 0;
  const [productName, setProductName] = useState("");
  const [tideweDraft, setTideweDraft] = useState(() => createTideweOutdoorProfile());
  const duration = String(tideweDraft.targetDuration);
  const videoMode = tideweDraft.videoMode;
  const updateTideweDraft = (update: Partial<TideweOutdoorProfile>) => setTideweDraft((previous) => ({ ...previous, ...update }));
  const [tideweProduct, setTideweProduct] = useState<TideweProductInput>({ category: "other", specifications: "" });
  const [tideweCopySource, setTideweCopySource] = useState<TideweCopySource>("ai");
  const [tideweCopyText, setTideweCopyText] = useState("");
  const [tideweSceneDescription, setTideweSceneDescription] = useState("");
  const useTideweOriginal = tideweCopySource === "manual";
  const { products: libraryProducts } = useProductLibraryStore();
  const [images, setImages] = useState<{ id: string; url: string; file: File }[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ step: string; percent: number; message: string } | null>(null);

  // handle image selection
  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const remaining = 5 - images.length;
      if (remaining <= 0) return;

      const newImages = Array.from(files)
        .slice(0, remaining)
        .filter((f) => f.type.startsWith("image/"))
        .map((file) => ({
          id: crypto.randomUUID(),
          url: URL.createObjectURL(file),
          file,
        }));

      setImages((prev) => [...prev, ...newImages]);
    },
    [images.length]
  );

  // drag event handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  // remove an image
  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  // Prefill the TIDEWE form and upload files from a saved product.
  const prefillFromProduct = useCallback(async (product: ProductItem) => {
    setProductName(product.name);
    setTideweProduct((previous) => ({ ...previous, specifications: product.description ?? "" }));
    // fetch product images as File objects: works for example/server images; local blob URLs expire across pages so skip those (text is already filled, user can upload manually)
    const files: { id: string; url: string; file: File }[] = [];
    for (const [i, src] of product.images.slice(0, 5).entries()) {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const file = new File([blob], `product-${i}.png`, { type: blob.type || "image/png" });
        files.push({ id: crypto.randomUUID(), url: URL.createObjectURL(file), file });
      } catch {
        // non-fatal if the image cannot be fetched
      }
    }
    if (files.length) {
      setImages((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.url));
        return files;
      });
    }
  }, []);

  // on mount, if ?productId is present, pre-fill once from the product library (products are only available after the store hydrates, hence the dependency)
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    const productId = new URLSearchParams(window.location.search).get("productId");
    if (!productId) return;
    const product = libraryProducts.find((p) => p.id === productId);
    if (product) {
      prefilledRef.current = true;
      void prefillFromProduct(product);
    }
  }, [libraryProducts, prefillFromProduct]);

  const hasProductInput = productName.trim().length > 0 && images.length >= 1;
  const sellingPointsMissing = !tideweProduct.specifications.trim();
  const originalCopyError = useTideweOriginal ? tideweCopyInputError(tideweCopyText) : undefined;
  const isValid = hasProductInput && !sellingPointsMissing && !originalCopyError;

  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const creativeProfile = createTideweOutdoorProfile(tideweDraft);
      const creativeProfileDrafts = { tidewe_outdoor: creativeProfile };
      setProgress({ step: "creating", percent: 15, message: t("progressCreating") });
      const projectRes = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${productName} · TIDEWE`,
          productName,
          productCategory: tideweProduct.category,
          productDescription: tideweProduct.specifications,
          productFacts: buildTideweProductFacts(tideweProduct),
          productImages: [],
          videoMode,
          creativeProfile,
          creativeProfileDrafts,
        }),
      });
      if (!projectRes.ok) throw new Error(t("errorCreateFailed"));
      const project = await projectRes.json();

      setProgress({ step: "uploading", percent: 35, message: t("progressUploading") });
      const formData = new FormData();
      images.forEach((img) => formData.append("files", img.file));
      formData.append("projectId", project.id);
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const errData = await uploadRes.json().catch(() => ({}));
        throw new Error(errData.error || t("errorUploadFailed"));
      }
      const { paths } = await uploadRes.json();
      const imagePatchRes = await fetch(`/api/project/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productImages: paths, expectedCreativeConfigRevision: project.creativeConfigRevision }),
      });
      if (!imagePatchRes.ok) throw new Error(t("errorUploadFailed"));
      const updatedProject = await imagePatchRes.json();

      setProgress({ step: "generating", percent: 60, message: tt(useTideweOriginal ? "copyInputGenerating" : "generating") });
      const generationRun = await submitGenerationRun({
        projectId: project.id, clientRequestId: crypto.randomUUID(), kind: "script",
        items: [{ kind: "script", request: {
          projectId: project.id,
          requestId: crypto.randomUUID(),
          expectedCreativeConfigRevision: updatedProject.creativeConfigRevision ?? project.creativeConfigRevision ?? 0,
          count: 1,
          ...(useTideweOriginal && { copyText: tideweCopyText }),
          ...(!useTideweOriginal && tideweSceneDescription.trim() && { sceneDescription: tideweSceneDescription.trim() }),
          productName,
          category: tideweProduct.category,
          productDescription: tideweProduct.specifications,
          targetDuration: creativeProfile.targetDuration,
          styleType: creativeProfile.styleType,
          videoMode,
          creativeProfile,
          creativeProfileDrafts,
          productImages: paths,
          llmConfig: {
            provider: llm.provider,
            baseUrl: llm.baseUrl,
            apiKey: llm.apiKey,
            model: llm.model,
            visionModel: llm.visionModel,
          },
          platforms: "tiktok",
        } }],
      });
      if (pageAlive.current) router.push(`/project/${project.id}/script?runId=${encodeURIComponent(generationRun.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGeneric"));
      setIsSubmitting(false);
      setProgress(null);
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      <main className="mx-auto max-w-2xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("pageTitlePrefix")}<span className="brand-gradient-text">{tt("title")}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">{tt("description")}</p>
        </div>

        <div className="space-y-6">
          <Card className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">1</span>
                <span className="text-sm font-semibold">{t("creationTypeLabel")}</span>
              </div>
              <div className="flex items-start gap-3 p-3.5 rounded-lg border border-primary bg-primary/10">
                <LuEye className="w-5 h-5 shrink-0 mt-0.5 text-primary" />
                <div>
                  <span className="text-sm font-medium text-primary">{tt("label")}</span>
                  <span className="text-xs text-muted-foreground mt-0.5 block">{tt("description")}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* LLM configuration */}
          {!isLLMConfigured && (
            <Link href="/settings?tab=llm">
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 cursor-pointer hover:bg-amber-500/15 transition-colors">
                <LuCircleAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-200">{t("llmWarnTitle")}</p>
                  <p className="text-xs text-amber-300/80 mt-0.5">{t("llmWarnDesc")}<span className="underline">{t("llmWarnCta")}</span></p>
                </div>
              </div>
            </Link>
          )}

          {/* Upload product images */}
          <Card className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">2</span>
                  <span className="text-sm font-semibold">
                    {t("stepUploadTitle")}
                    <span className="text-destructive ml-0.5">*</span>
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t("imageCount", { n: images.length })}
                </span>
              </div>

              {/* drag-and-drop upload zone */}
              {images.length < 5 && (
                <div
                  className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                    isDragging
                      ? "border-primary bg-primary/5"
                      : "border-border/60 hover:border-primary/50 hover:bg-muted/20"
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      handleFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50">
                      <LuUpload className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {t("dropHintPrefix")}
                        <span className="brand-gradient-text font-semibold">{t("dropHintClick")}</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t("dropHintFormats")}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* uploaded image preview grid */}
              {images.length > 0 && (
                <div className={`grid grid-cols-3 sm:grid-cols-5 gap-3 ${images.length < 5 ? "mt-4" : ""}`}>
                  {images.map((img) => (
                    <div
                      key={img.id}
                      className="group relative aspect-square rounded-lg overflow-hidden border border-border/50 bg-muted/20"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={t("imageAlt")}
                        className="h-full w-full object-cover"
                      />
                      {/* delete button */}
                      <button
                        type="button"
                        aria-label={t("removeImage")}
                        title={t("removeImage")}
                        disabled={isSubmitting}
                        onClick={() => removeImage(img.id)}
                        className="absolute top-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity hover:bg-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:bg-black/40"
                      >
                        <LuX className="w-3 h-3" />
                      </button>
                      {/* hover overlay */}
                      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 rounded-lg border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
                <p className="text-xs leading-relaxed text-muted-foreground">{tt("modeHint")}</p>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardContent className="p-5 space-y-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">3</span>
                <span className="text-sm font-semibold">{t("stepInfoTitle")}</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="productName" className="text-sm font-medium">
                  {t("productNameLabel")}
                  <span className="text-destructive ml-0.5">*</span>
                </Label>
                <Input
                  id="productName"
                  placeholder={tt("productNamePlaceholder")}
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className="bg-muted/30 border-border/50 focus:border-primary"
                />
              </div>
              <TideweProductFields value={tideweProduct} onChange={setTideweProduct} />
              <TideweCopyInput source={tideweCopySource} text={tideweCopyText} sceneDescription={tideweSceneDescription} onSourceChange={setTideweCopySource} onTextChange={setTideweCopyText} onSceneDescriptionChange={setTideweSceneDescription} disabled={isSubmitting} />
            </CardContent>
          </Card>

          {/* video configuration (target duration + video mode) */}
          <Card className="glass-card">
            <CardContent className="p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">4</span>
                <span className="text-sm font-semibold">{t("stepConfigTitle")}</span>
              </div>

              {/* target duration */}
              <Label className="text-sm font-medium mb-3 block">{t("durationLabel")}</Label>
              <div className="grid grid-cols-3 gap-3">
                {durationOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      updateTideweDraft({ targetDuration: Number(opt.value) as TideweOutdoorProfile["targetDuration"] });
                    }}
                    className={`relative flex items-center justify-center h-11 rounded-lg border text-sm font-medium transition-all ${
                      duration === opt.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/50 bg-muted/20 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                    {/* selected indicator */}
                    {duration === opt.value && (
                      <div className="absolute -top-px -right-px h-4 w-4 flex items-center justify-center">
                        <div className="h-2 w-2 rounded-full brand-gradient" />
                      </div>
                    )}
                  </button>
                ))}
              </div>

              <div className="mt-4 space-y-3">
                <p className="text-xs text-primary">{tt("language")}</p>
                {!useTideweOriginal && <><Label htmlFor="tidewe-angle">{tt("angle")}</Label>
                <select id="tidewe-angle" value={tideweDraft.narrativeAngle} onChange={(event) => updateTideweDraft({ narrativeAngle: event.target.value as TideweOutdoorProfile["narrativeAngle"] })} className="h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm">
                  {["auto", "scene_pain", "choice", "use_demo", "long_wait", "gift"].map((angle) => <option key={angle} value={angle}>{tt(`angle_${angle}`)}</option>)}
                </select></>}
              </div>
              {/* divider */}
              <div className="my-5 border-t border-border/40" />

              {/* video mode */}
              <Label className="text-sm font-medium mb-3 block">
                {t("videoModeLabel")}
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {videoModeOptions.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        updateTideweDraft({ videoMode: opt.value });
                      }}
                      className={`relative flex items-start gap-3 p-3.5 rounded-lg border text-left transition-all ${
                        videoMode === opt.value
                          ? "border-primary bg-primary/10"
                          : "border-border/50 bg-muted/20 hover:border-primary/40"
                      }`}
                    >
                      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${videoMode === opt.value ? "text-primary" : "text-muted-foreground"}`} />
                      <div>
                        <span className={`text-sm font-medium ${videoMode === opt.value ? "text-primary" : "text-foreground"}`}>
                          {tt(opt.labelKey)}
                        </span>
                        <span className="text-xs text-muted-foreground mt-0.5 block">{tt(opt.descKey)}</span>
                      </div>
                      {videoMode === opt.value && (
                        <div className="absolute top-2.5 right-2.5">
                          <div className="h-2 w-2 rounded-full brand-gradient" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 space-y-2 border-t border-border/40 pt-5">
                <Label htmlFor="tidewe-speech-mode" className="text-sm font-medium">{tt("speechMode")}</Label>
                <select
                  id="tidewe-speech-mode"
                  aria-label={tt("speechMode")}
                  aria-describedby="tidewe-speech-description"
                  value={tideweDraft.speechMode}
                  disabled={isSubmitting}
                  onChange={(event) => updateTideweDraft({ speechMode: event.target.value as TideweOutdoorProfile["speechMode"] })}
                  className="h-10 w-full rounded-md border border-border/50 bg-background px-3 text-sm"
                >
                  <option value="on_camera">{tt("speechOnCamera")}</option>
                  <option value="voiceover">{tt("speechVoiceover")}</option>
                </select>
                <p id="tidewe-speech-description" className="text-xs leading-relaxed text-muted-foreground">
                  {tt(tideweDraft.speechMode === "on_camera" ? "speechOnCameraDescription" : "speechVoiceoverDescription")}
                </p>
              </div>

              <div className="mt-5 border-t border-border/40 pt-5">
                <TidewePresenterPicker value={tideweDraft.presenter} onChange={(presenter) => updateTideweDraft({ presenter })} disabled={isSubmitting} />
              </div>

            </CardContent>
          </Card>

          {/* submit button */}
          <div className="pt-2 pb-10">
            {/* error message */}
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive flex items-center gap-2">
                  <LuCircleAlert className="w-4 h-4 shrink-0" />
                  {error}
                </p>
              </div>
            )}

            {/* progress bar */}
            {progress && (
              <div className="mb-4">
                <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                  <div
                    className="h-full brand-gradient transition-all duration-500 rounded-full"
                    style={{ width: `${progress.percent}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center mt-2">
                  {progress.message}
                </p>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting || !isLLMConfigured}
              className="w-full h-12 brand-gradient text-white font-semibold text-base shadow-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <svg className="animate-spin mr-2 h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {progress?.message || t("submitProcessing")}
                </>
              ) : (
                <>
                  <LuZap className="w-5 h-5 mr-2" />
                  {tt(useTideweOriginal ? "copyInputGenerate" : "submit")}
                </>
              )}
            </Button>
            {!isSubmitting && (
              <p className="text-xs text-muted-foreground text-center mt-3">
                {!isLLMConfigured
                  ? t("hintNeedLlm")
                  : !isValid
                    ? !hasProductInput ? t("hintNeedInput") : sellingPointsMissing ? tt("sellingPointsRequired") : originalCopyError ? tt(originalCopyError) : t("hintNeedInput")
                    : tt(useTideweOriginal ? "copyInputReady" : "ready")}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
