"use client";

import { useModelCatalog } from "@/lib/hooks/use-model-catalog";
import { ModelCatalogStatus } from "@/components/model-catalog-status";
import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LuTriangleAlert } from "react-icons/lu";
import { ARK_STANDARD_BASE_URL, ARK_AGENT_PLAN_BASE_URL, isArkAgentPlanBase } from "@/lib/ark-config";
import { useT } from "@/lib/i18n";
import { useSettingsStore, type ProviderSetting } from "@/lib/stores/settings-store";
import { HTH_BASE_URL, HTH_DEFAULT_MODEL } from "@/lib/hth-config";
import { mergeCustomModels } from "@/lib/gen-params";
import { ModelPicker } from "@/components/settings/model-picker";
import { GenerationSettings } from "@/components/generation-settings";
import { PresenterManager } from "@/components/presenter-manager";
import { KlingCliSettings } from "@/components/settings/kling-cli-settings";
import { TTSSettings } from "@/components/settings/tts-settings";
import { ConfigurationTransfer } from "@/components/settings/configuration-transfer";
import { configuredCatalogProviders } from "@/lib/model-catalog";

// default resolution options
const resolutionOptions = [
  { value: "720p", label: "720p (1280x720)" },
  { value: "1080p", label: "1080p (1920x1080)" },
];

// default aspect ratio options (labelKey is rendered per language inside the component)
const aspectRatioOptions = [
  { value: "9:16", labelKey: "aspect916" },
  { value: "16:9", labelKey: "aspect169" },
  { value: "1:1", labelKey: "aspect11" },
];

// Settings sections, in display order (id doubles as the ?tab= value)
const SETTINGS_SECTIONS = [
  { id: "providers", labelKey: "tabProviders" },
  { id: "llm", labelKey: "tabLlm" },
  { id: "image", labelKey: "tabImage" },
  { id: "video", labelKey: "tabVideo" },
  { id: "tts", labelKey: "tabTts" },
  { id: "characters", labelKey: "tabCharacters" },
];
const SETTINGS_TABS: string[] = SETTINGS_SECTIONS.map((s) => s.id);

// AI platform configuration list
const AI_PROVIDERS = [
  {
    key: "atlas-cloud",
    name: "Atlas Cloud",
    descKey: "providerAtlasDesc",
    tipKey: "providerAtlasTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
    ),
    iconBg: "from-blue-500 to-cyan-500",
  },
  {
    key: "fal-ai",
    name: "fal.ai",
    descKey: "providerFalDesc",
    tipKey: "providerFalTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    iconBg: "from-purple-500 to-pink-500",
  },
  {
    key: "replicate",
    name: "Replicate",
    descKey: "providerReplicateDesc",
    tipKey: "providerReplicateTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
    iconBg: "from-slate-500 to-gray-700",
  },
  {
    key: "volcengine",
    name: "火山引擎",
    descKey: "providerVolcengineDesc",
    tipKey: "providerVolcengineTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
      </svg>
    ),
    iconBg: "from-orange-500 to-red-500",
  },
  {
    key: "alibaba",
    name: "阿里百炼",
    descKey: "providerAlibabaDesc",
    tipKey: "providerAlibabaTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    ),
    iconBg: "from-amber-500 to-orange-500",
  },
  {
    key: "siliconflow",
    name: "硅基流动",
    descKey: "providerSiliconflowDesc",
    tipKey: "providerSiliconflowTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M15 2v2" />
        <path d="M15 20v2" />
        <path d="M2 15h2" />
        <path d="M2 9h2" />
        <path d="M20 15h2" />
        <path d="M20 9h2" />
        <path d="M9 2v2" />
        <path d="M9 20v2" />
      </svg>
    ),
    iconBg: "from-emerald-500 to-teal-500",
  },
  {
    key: "openai",
    name: "HTH",
    descKey: "providerOpenaiDesc",
    tipKey: "providerOpenaiTip",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a4.5 4.5 0 0 1 4.27 3.08A4.5 4.5 0 0 1 19.5 12a4.5 4.5 0 0 1-3.23 6.92A4.5 4.5 0 0 1 12 22a4.5 4.5 0 0 1-4.27-3.08A4.5 4.5 0 0 1 4.5 12a4.5 4.5 0 0 1 3.23-6.92A4.5 4.5 0 0 1 12 2z" />
        <path d="M12 8.5v7M8.5 10.25l7 3.5M15.5 10.25l-7 3.5" />
      </svg>
    ),
    iconBg: "from-teal-600 to-green-700",
  },
];

// Keep these integrations available to existing projects while hiding their setup cards from the UI.
const HIDDEN_AI_PROVIDER_KEYS = new Set(["atlas-cloud", "fal-ai", "replicate", "volcengine", "alibaba", "siliconflow"]);
const VISIBLE_AI_PROVIDERS = [
  ...AI_PROVIDERS.filter((platform) => platform.key === "openai" && !HIDDEN_AI_PROVIDER_KEYS.has(platform.key)),
  ...AI_PROVIDERS.filter((platform) => platform.key !== "openai" && !HIDDEN_AI_PROVIDER_KEYS.has(platform.key)),
];

// Map Chinese vendor names by key to i18n display names (English users would otherwise see hard-coded Chinese like "火山引擎/阿里百炼/硅基流动").
// Only overrides vendors with Chinese names; others (Atlas Cloud/OpenAI, etc.) already use English brand names and use platform.name directly.
// Note: platform.name is still used as the identity for enabledNames custom model filtering, so we only change the display, not name.
const PROVIDER_NAME_KEYS: Record<string, string> = {
  volcengine: "providerVolcengineName",
  alibaba: "providerAlibabaName",
  siliconflow: "providerSiliconflowName",
};

// password input field with show/hide toggle
function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${className ?? ""}`}>
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10 font-mono text-xs"
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
      >
        {visible ? (
          // hide icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          </svg>
        ) : (
          // show icon
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const t = useT("settings");
  // read settings from store
  const {
    providers,
    llm,
    defaultResolution,
    spendCapUsd,
    setSpendCapUsd,
    defaultAspectRatio,
    defaultImageModel,
    defaultVideoModel,
    customModels,
    setProvider,
    setLLM,
    setDefaultResolution,
    setDefaultAspectRatio,
    setDefaultImageModel,
    setDefaultVideoModel,
  } = useSettingsStore();

  // AI platform key connectivity test (real auth probe, not a fake test)
  const [providerTest, setProviderTest] = useState<Record<string, { state: "idle" | "testing" | "ok" | "invalid" | "unknown"; msg?: string }>>({});
  const providerTestVersions = useRef<Record<string, number>>({});
  const updateProvider = (key: string, setting: ProviderSetting) => {
    setProvider(key, setting);
    providerTestVersions.current[key] = (providerTestVersions.current[key] ?? 0) + 1;
    setProviderTest((s) => ({ ...s, [key]: { state: "idle" } }));
  };
  const testProvider = async (key: string) => {
    const p = providers[key];
    if (!p?.apiKey) return;
    const version = (providerTestVersions.current[key] ?? 0) + 1;
    providerTestVersions.current[key] = version;
    setProviderTest((s) => ({ ...s, [key]: { state: "testing" } }));
    try {
      const res = await fetch("/api/ai/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: key, apiKey: p.apiKey, baseUrl: p.baseUrl }),
      });
      const data = await res.json();
      if (providerTestVersions.current[key] !== version) return;
      setProviderTest((s) => ({ ...s, [key]: { state: data.status ?? "unknown", msg: data.message } }));
    } catch {
      if (providerTestVersions.current[key] !== version) return;
      setProviderTest((s) => ({ ...s, [key]: { state: "unknown", msg: t("connectFailed") } }));
    }
  };

  // save feedback state

  const imageProviders = configuredCatalogProviders(providers, "image");
  const videoProviders = configuredCatalogProviders(providers, "video");
  const imageCatalog = useModelCatalog(imageProviders, "image");
  const videoCatalog = useModelCatalog(videoProviders, "video");
  const imageModels = imageCatalog.models.filter((model) => model.mediaType === "image");
  const videoModels = videoCatalog.models.filter((model) => model.mediaType === "video" && model.provider === "kling-cli");

  // merge user custom models into dropdowns (enabled providers only), so custom models can be selected as default
  const imageProviderNames = new Set(imageProviders.map((p) => p.name));
  const videoProviderNames = new Set(videoProviders.map((p) => p.name));
  const imageModelOptions = mergeCustomModels(imageModels, customModels, "image", imageProviderNames);
  const videoModelOptions = mergeCustomModels(videoModels, customModels, "video", videoProviderNames).filter((model) => model.provider === "kling-cli");

  // Image defaults retain their initial convenience selection. Video models are an explicit
  // choice here, so catalog refreshes and provider-mode changes cannot change the billed model.
  const imageIds = imageModelOptions.map((m) => m.id).join(",");
  const selectedVideoModel = videoModelOptions.find((model) => model.id === defaultVideoModel);
  const videoSelectionUnavailable = Boolean(defaultVideoModel && !videoCatalog.loading && !selectedVideoModel);
  useEffect(() => {
    if (imageModelOptions.length && !defaultImageModel) {
      setDefaultImageModel(imageModelOptions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIds]);

  // LLM connection test state
  const [llmTestStatus, setLlmTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

  // Active tab, synced with ?tab= so "go to settings" links can deep-link a section
  const [tab, setTab] = useState("providers");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("tab");
    if (q && SETTINGS_TABS.includes(q)) setTab(q);
  }, []);
  const switchTab = (v: string) => {
    setTab(v);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", v);
    window.history.replaceState(null, "", url.toString());
  };

  // test LLM connection
  const [llmTestError, setLlmTestError] = useState("");
  // 连接通过但仍有值得知道的事（例如该模型输出上限极小）——绿灯照给，附一行提醒
  const [llmTestWarning, setLlmTestWarning] = useState("");
  const testLLMConnection = async () => {
    setLlmTestStatus("testing");
    setLlmTestError("");
    setLlmTestWarning("");
    try {
      // use server-side test: browser direct calls to provider APIs would be blocked by CORS and falsely report failure
      const res = await fetch("/api/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      setLlmTestStatus(data.ok ? "success" : "error");
      if (!data.ok) setLlmTestError(data.error || t("connectFailed"));
      if (data.warning) setLlmTestWarning(data.warning);
    } catch (e) {
      setLlmTestStatus("error");
      setLlmTestError(e instanceof Error ? e.message : t("connectFailed"));
    }
    // 成功 5 秒后收起；失败保持到下一次测试——可行动的报错往往有两三行，5 秒读不完（issue #19 追问）
    setTimeout(() => setLlmTestStatus((s) => (s === "error" ? s : "idle")), 5000);
  };

  // compute AI provider configuration status
  const hasAnyProvider = Object.values(providers).some(p => p.enabled && p.apiKey);


  return (
    <div className="min-h-screen grid-bg">
      <main className="mx-auto max-w-4xl px-6 py-10">
        {/* page title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("pageSubtitle")}
          </p>
        </div>

        <ConfigurationTransfer />
        {/* configuration status banner: surfaces missing setup right at the top (the footer summary is easy to miss) */}
        {(!llm.apiKey || !hasAnyProvider) && (
          <div className="mb-6 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <LuTriangleAlert className="w-4 h-4 shrink-0 text-amber-500" />
              <h2 className="font-semibold text-sm text-amber-600 dark:text-amber-400">{t("configBannerTitle")}</h2>
            </div>
            <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-400/90">
              {!llm.apiKey && <li>{t("llmNotConfigured")}</li>}
              {!hasAnyProvider && <li>{t("noProvider")}</li>}
            </ul>
          </div>
        )}

        {/* tabs */}
        <div className="md:flex md:items-start md:gap-8">
          {/* Section rail: vertical on desktop (native settings-window feel), horizontal scroll on mobile */}
          <nav className="mb-6 flex gap-1 overflow-x-auto md:sticky md:top-6 md:mb-0 md:w-44 md:shrink-0 md:flex-col">
            {SETTINGS_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                onClick={() => switchTab(sec.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  tab === sec.id
                    ? "bg-primary/15 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {t(sec.labelKey)}
              </button>
            ))}
          </nav>

          {/* Tab 1: AI provider configuration */}
          {tab === "providers" && (
          <section className="min-w-0 flex-1">
            <div className="space-y-4">
              <KlingCliSettings onCatalogChanged={() => videoCatalog.retry("kling-cli")} />
              {VISIBLE_AI_PROVIDERS.map((platform) => {
                const provider = providers[platform.key] ?? {
                  enabled: false,
                  apiKey: "",
                };
                const isArk = platform.key === "volcengine";
                const arkAgentPlan = isArk && isArkAgentPlanBase(provider.baseUrl);

                return (
                  <Card key={platform.key} className="glass-card">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        {/* provider info */}
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${platform.iconBg} text-white shadow-lg`}
                          >
                            {platform.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-sm">
                                {PROVIDER_NAME_KEYS[platform.key] ? t(PROVIDER_NAME_KEYS[platform.key]) : platform.name}
                              </h3>
                              {provider.enabled && (
                                <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
                                  {t("providerEnabled")}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {t(platform.descKey)}
                            </p>
                            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t(platform.tipKey)}</p>
                          </div>
                        </div>

                        {/* enable toggle */}
                        <ToggleSwitch
                          checked={provider.enabled}
                          onChange={(enabled) =>
                            updateProvider(platform.key, {
                              ...provider,
                              enabled,
                            })
                          }
                        />
                      </div>

                      {isArk && (
                        <div className="mt-4 space-y-1.5">
                          <Label htmlFor="ark-api-mode" className="text-xs text-muted-foreground">
                            {t("arkApiModeLabel")}
                          </Label>
                          <Select
                            value={arkAgentPlan ? "agent-plan" : "standard"}
                            onValueChange={(value) => {
                              if (!value) return;
                              updateProvider(platform.key, {
                                ...provider,
                                baseUrl: value === "agent-plan" ? ARK_AGENT_PLAN_BASE_URL : ARK_STANDARD_BASE_URL,
                              });
                            }}
                          >
                            <SelectTrigger id="ark-api-mode" className="w-full">
                              <SelectValue>
                                {(value: string) => t(value === "agent-plan" ? "arkApiModeAgentPlan" : "arkApiModeStandard")}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="standard">{t("arkApiModeStandard")}</SelectItem>
                              <SelectItem value="agent-plan">{t("arkApiModeAgentPlan")}</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {t(arkAgentPlan ? "arkAgentPlanHint" : "arkStandardHint")}
                          </p>
                          {arkAgentPlan && (
                            <p className="text-[11px] text-muted-foreground/80 leading-relaxed break-words">
                              {t("arkAgentPlanModels")}
                            </p>
                          )}
                        </div>
                      )}

                      {/* API Key input */}
                      <div className="mt-4">
                        <Label className="text-xs text-muted-foreground mb-1.5">
                          API Key
                        </Label>
                        <PasswordInput
                          value={provider.apiKey}
                          onChange={(apiKey) =>
                            updateProvider(platform.key, {
                              ...provider,
                              apiKey,
                            })
                          }
                          placeholder={arkAgentPlan ? t("arkAgentPlanKeyPlaceholder") : t("apiKeyPlaceholder", { name: platform.name })}
                        />
                        {/* Key connectivity test: real auth probe ✓/✗/⚠ */}
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            disabled={!provider.apiKey || providerTest[platform.key]?.state === "testing"}
                            onClick={() => testProvider(platform.key)}
                          >
                            {providerTest[platform.key]?.state === "testing" ? t("llmTestTesting") : t("llmTestButton")}
                          </Button>
                          {(() => {
                            const r = providerTest[platform.key];
                            if (!r || r.state === "idle" || r.state === "testing") return null;
                            const color = r.state === "ok" ? "text-emerald-500" : r.state === "invalid" ? "text-destructive" : "text-amber-500";
                            const icon = r.state === "ok" ? "✓" : r.state === "invalid" ? "✗" : "⚠";
                            return <span className={`text-xs ${color}`}>{icon} {r.msg}</span>;
                          })()}
                        </div>
                      </div>

                      {/* custom endpoint (proxy/self-hosted, optional) — collapsed by default so beginners are not disturbed */}
                      <details className="mt-3">
                        <summary className="text-xs text-muted-foreground/70 cursor-pointer list-none select-none hover:text-muted-foreground">
                          {t("providerBaseUrlLabel")}
                        </summary>
                        <div className="mt-2">
                          <Input
                            value={provider.baseUrl ?? (platform.key === "openai" ? HTH_BASE_URL : "")}
                            onChange={(e) =>
                              updateProvider(platform.key, {
                                ...provider,
                                baseUrl: e.target.value || (platform.key === "openai" ? HTH_BASE_URL : undefined),
                              })
                            }
                            placeholder={platform.key === "openai" ? HTH_BASE_URL : t("providerBaseUrlPlaceholder")}
                            className="font-mono text-xs"
                          />
                          {platform.key === "openai" && (
                            <p className="mt-2 text-xs text-muted-foreground">{t("openaiBaseUrlHint")}</p>
                          )}
                        </div>
                      </details>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
          )}

          {/* Tab 2: LLM configuration */}
          {tab === "llm" && (
          <section className="min-w-0 flex-1">
            <div className="space-y-6">
              {/* LLM Provider configuration */}
              <Card className="glass-card">
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 text-white">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <h3 className="font-semibold text-sm">{t("llmProvider")}</h3>
                  </div>

                  <div className="grid gap-4">
                    {/* API base URL */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("llmBaseUrlLabel")}
                      </Label>
                      <Input
                        value={llm.baseUrl}
                        onChange={(e) =>
                          setLLM({ ...llm, baseUrl: e.target.value })
                        }
                        placeholder={HTH_BASE_URL}
                        className="font-mono text-xs"
                      />
                    </div>

                    {/* API Key */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("apiKeyLabel")}
                      </Label>
                      <PasswordInput
                        value={llm.apiKey}
                        onChange={(apiKey) => setLLM({ ...llm, apiKey })}
                        placeholder={t("llmApiKeyPlaceholder")}
                      />
                      {/* Pollinations 已改为「注册领每日免费额度」，直接把领 Key 的地址摆在输入框下面 */}
                      {/pollinations\.ai/i.test(llm.baseUrl) && (
                        <p className="text-xs text-muted-foreground">
                          {t("pollinationsKeyHint")}{" "}
                          <a
                            href="https://enter.pollinations.ai/keys"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline underline-offset-2"
                          >
                            enter.pollinations.ai/keys
                          </a>
                        </p>
                      )}
                    </div>

                    {/* model name */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {t("llmTextModel")}
                        </Label>
                        <Input
                          value={llm.model}
                          onChange={(e) =>
                            setLLM({ ...llm, model: e.target.value })
                          }
                          placeholder={HTH_DEFAULT_MODEL}
                          className="font-mono text-xs"
                        />
                        {/* 模型名靠手打是最常见的错配来源，本地 Ollama 还必须带 :tag（issue #19 追问） */}
                        <ModelPicker
                          baseUrl={llm.baseUrl}
                          apiKey={llm.apiKey}
                          onPick={(model) => setLLM({ ...llm, model })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {t("llmVisionModel")}
                        </Label>
                        <Input
                          value={llm.visionModel ?? ""}
                          onChange={(e) =>
                            setLLM({
                              ...llm,
                              visionModel: e.target.value || undefined,
                            })
                          }
                          placeholder={HTH_DEFAULT_MODEL}
                          className="font-mono text-xs"
                        />
                        <ModelPicker
                          baseUrl={llm.baseUrl}
                          apiKey={llm.apiKey}
                          onPick={(visionModel) => setLLM({ ...llm, visionModel })}
                        />
                      </div>
                    </div>
                    {/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434/i.test(llm.baseUrl) && (
                      <p className="text-xs text-muted-foreground -mt-2">{t("ollamaModelHint")}</p>
                    )}

                    {/* test connection button */}
                    <div className="pt-3 mt-3 border-t border-border/50">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={testLLMConnection}
                        disabled={!llm.apiKey || !llm.baseUrl || llmTestStatus === "testing"}
                        className={`text-xs ${
                          llmTestStatus === "success"
                            ? "text-emerald-600"
                            : llmTestStatus === "error"
                            ? "text-destructive"
                            : ""
                        }`}
                      >
                        {llmTestStatus === "testing" ? t("llmTestTesting")
                         : llmTestStatus === "success" ? t("llmTestSuccess")
                         : llmTestStatus === "error" ? t("llmTestError")
                         : t("llmTestButton")}
                      </Button>
                      {!llm.apiKey && (
                        <span className="text-xs text-muted-foreground ml-2">{t("llmFillKeyFirst")}</span>
                      )}
                      {llmTestStatus === "error" && llmTestError && (
                        <p className="mt-2 text-xs text-destructive break-all">{llmTestError}</p>
                      )}
                      {llmTestWarning && (
                        <p className="mt-2 text-xs text-amber-600 break-all">{llmTestWarning}</p>
                      )}
                      <p className="mt-2 text-[11px] text-muted-foreground">{t("llmTestTip")}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
          )}

          {/* Tab: TTS voice-over */}
          {tab === "tts" && (
          <section className="min-w-0 flex-1">
            <div className="space-y-6">
              <TTSSettings />
            </div>
          </section>
          )}

          {/* Tab: image generation — pick the default model (keys live under Platform keys) */}
          {tab === "image" && (
          <section className="min-w-0 flex-1">
            <div className="space-y-6">
              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="font-semibold text-sm mb-4">{t("imageCardTitle")}</h3>
                  <ModelCatalogStatus statuses={imageCatalog.statuses} pending={imageCatalog.pending} onRetry={imageCatalog.retry} />
                  <div className="grid grid-cols-1 gap-4">
                    {/* default image generation model */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("defaultImageModel")}
                      </Label>
                      <Select
                        value={defaultImageModel}
                        onValueChange={(val) => setDefaultImageModel(val ?? "")}
                        disabled={imageModelOptions.length === 0}
                      >
                        <SelectTrigger className="w-full">
                          {/* Base UI Select.Value shows the raw value by default; use a function child to map it to the model name */}
                          <SelectValue>
                            {(value: string) =>
                              imageModelOptions.find((m) => m.id === value)?.name ??
                              (imageCatalog.loading ? t("modelsLoading") : imageProviders.length === 0 ? t("enableProviderFirst") : t("selectImageModel"))
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {imageModelOptions.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}{m.custom ? t("customModelSuffix") : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{t("modelsFromProvidersHint")}</p>
                </CardContent>
              </Card>
            </div>
          </section>
          )}

          {/* Tab: video generation — default model + output format */}
          {tab === "video" && (
          <section className="min-w-0 flex-1">
            <div className="space-y-6">
              <Card className="glass-card">
                <CardContent className="p-5">
                  <h3 className="font-semibold text-sm mb-4">{t("videoCardTitle")}</h3>
                  <ModelCatalogStatus statuses={videoCatalog.statuses} pending={videoCatalog.pending} onRetry={videoCatalog.retry} />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* default video generation model */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("defaultVideoModel")}
                      </Label>
                      <Select
                        value={defaultVideoModel}
                        onValueChange={(val) => setDefaultVideoModel(val ?? "")}
                        disabled={videoModelOptions.length === 0}
                      >
                        <SelectTrigger className="w-full">
                          {/* Base UI Select.Value shows the raw value by default; use a function child to map it to the model name */}
                          <SelectValue>
                            {(value: string) =>
                              videoModelOptions.find((m) => m.id === value)?.name ??
                              (videoCatalog.loading ? t("modelsLoading") : value ? t("videoModelUnavailable", { model: value }) : videoProviders.length === 0 ? t("enableProviderFirst") : t("selectVideoModel"))
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {videoModelOptions.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}{m.custom ? t("customModelSuffix") : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{t("defaultVideoModelScope")}</p>
                      {videoSelectionUnavailable && <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{t("defaultVideoModelReselect")}</p>}
                    </div>
                    {/* default resolution */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("defaultResolution")}
                      </Label>
                      <Select
                        value={defaultResolution}
                        onValueChange={(val) =>
                          setDefaultResolution(val as "720p" | "1080p")
                        }
                      >
                        <SelectTrigger className="w-full">
                          {/* Base UI Select.Value shows the raw value by default; use a function child to map it to a label */}
                          <SelectValue>
                            {(value: string) => resolutionOptions.find((o) => o.value === value)?.label ?? value}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {resolutionOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* per-run spend cap: a priced generation above this needs an explicit tick */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">{t("spendCap")}</Label>
                      <Input
                        type="number"
                        min={0}
                        step={0.5}
                        value={spendCapUsd}
                        onChange={(e) => setSpendCapUsd(Number(e.target.value))}
                      />
                      <p className="text-[11px] leading-4 text-muted-foreground">{t("spendCapHint")}</p>
                    </div>
                    {/* default aspect ratio */}
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {t("defaultAspectRatio")}
                      </Label>
                      <Select
                        value={defaultAspectRatio}
                        onValueChange={(val) =>
                          setDefaultAspectRatio(
                            val as "9:16" | "16:9" | "1:1"
                          )
                        }
                      >
                        <SelectTrigger className="w-full">
                          {/* Base UI Select.Value shows the raw value by default; use a function child to map it to a language-specific label */}
                          <SelectValue>
                            {(value: string) => {
                              const o = aspectRatioOptions.find((o) => o.value === value);
                              return o ? t(o.labelKey) : value;
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {aspectRatioOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {t(o.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{t("modelsFromProvidersHint")}</p>
                </CardContent>
              </Card>
            </div>
          </section>
          )}
          {/* Tab 3: character management */}
          {tab === "characters" && (
          <section className="min-w-0 flex-1">
            <PresenterManager />
          </section>
          )}
        </div>

        {/* custom model endpoints + generation params (advanced, cross-cutting, collapsed) */}
        <div className="mt-6">
              {/* custom model endpoints + generation params (advanced, collapsed by default, does not disturb beginners) */}
              <details className="group rounded-xl border border-border/50 bg-card/30">
                <summary className="flex items-center justify-between cursor-pointer list-none select-none px-5 py-3.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                  <span>{t("advancedSection")}</span>
                  <svg className="size-4 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>
                </summary>
                <div className="px-1 pb-1 space-y-4">
                  <GenerationSettings />
                </div>
              </details>
        </div>

        {/* zustand persists every change instantly — say so instead of showing a fake save button */}
        <p className="mt-8 text-xs text-muted-foreground">{t("autoSaveHint")}</p>

      </main>
    </div>
  );
}
