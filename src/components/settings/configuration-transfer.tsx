"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { exportConfiguration, importConfiguration } from "@/lib/browser-storage";
import { useLocale } from "@/lib/i18n";

export function ConfigurationTransfer() {
  const locale = useLocale();
  const english = locale === "en";
  const input = useRef<HTMLInputElement>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [error, setError] = useState("");
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(exportConfiguration(includeSecrets), null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `clipforge-settings-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error(english ? "Configuration file is too large" : "配置文件过大");
      importConfiguration(JSON.parse(await file.text()));
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (input.current) input.current.value = ""; }
  }
  return <div className="mb-6 rounded-xl border border-border p-4">
    <p className="text-sm font-medium">{english ? "Move settings between Web and Desktop" : "Web 与客户端之间迁移设置"}</p>
    <p className="mt-1 text-xs text-muted-foreground">{english ? "Transfer service settings, voices, brands and saved libraries. Project files and OAuth accounts are migrated separately." : "导出服务、声音、品牌和资料库设置。项目文件与 OAuth 账号需单独迁移。"}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button size="sm" variant="outline" onClick={download}>{english ? "Export settings" : "导出设置"}</Button>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()}>{english ? "Import and replace matching settings" : "导入并覆盖同名设置"}</Button>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includeSecrets} onChange={event => setIncludeSecrets(event.target.checked)} />{english ? "Include service keys in export" : "导出时包含服务密钥"}</label>
      <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={event => void upload(event.target.files?.[0])} />
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
