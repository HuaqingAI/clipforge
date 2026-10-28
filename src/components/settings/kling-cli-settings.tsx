"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { klingFetch, klingErrorMessage } from "@/lib/kling/client";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { KLING_PACKAGE, KLING_VERSION, type KlingAuthSession, type KlingPublicStatus } from "@/lib/kling/types";

const AUTH_LABELS: Record<string, string> = {
  unknown: "尚未核验登录", logged_out: "尚未登录", logging_in: "正在登录", authenticated: "已登录",
  reauth_required: "需要重新登录", account_mismatch: "账号不一致，原任务需使用原账号恢复",
};
const LOGIN_LABELS: Record<string, string> = {
  queued: "等待登录", starting: "正在启动登录", waiting_browser: "请在浏览器完成官方授权",
  verifying: "正在核验账号", succeeded: "登录成功", failed: "登录失败", cancelled: "登录已停止", interrupted: "登录已中断",
};
const ACTIVE_LOGIN = new Set(["queued", "starting", "waiting_browser", "verifying"]);

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(klingErrorMessage(data, "Kling 操作失败，请重试"));
  return data as T;
}

/** The browser only saves a non-secret profile reference. CLI paths and credentials stay on this machine. */
export function KlingCliSettings({ onCatalogChanged }: { onCatalogChanged?: () => void }) {
  const provider = useSettingsStore((state) => state.providers["kling-cli"]);
  const setProvider = useSettingsStore((state) => state.setProvider);
  const profileId = provider?.profileId;
  const enabled = provider?.enabled ?? false;
  const [status, setStatus] = useState<KlingPublicStatus | null>(null);
  const [nodePath, setNodePath] = useState("");
  const [packagePath, setPackagePath] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<KlingAuthSession | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const generation = useRef(0);
  const accountNotice = useRef<{ profileId: string; message: string; error?: string } | null>(null);
  const catalogChanged = useRef(onCatalogChanged);
  catalogChanged.current = onCatalogChanged;

  const loadStatus = useCallback(async (id?: string, signal?: AbortSignal) => {
    return readResponse<KlingPublicStatus>(await klingFetch(`/api/integrations/kling/status${id ? `?profileId=${encodeURIComponent(id)}` : ""}`, { signal, cache: "no-store" }));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setStatus(null);
    setSession(null);
    setAuthorizationUrl("");
    setError("");
    setMessage("");
    if (!enabled && !profileId) { setBusy(""); return () => { controller.abort(); generation.current = current + 1; }; }
    setBusy("status");
    void loadStatus(profileId, controller.signal).then((next) => {
      if (generation.current !== current) return;
      setStatus(next);
      setNodePath(next.profile?.nodePath ?? next.installationDefaults?.nodePath ?? "");
      setPackagePath(next.profile?.packagePath ?? next.installationDefaults?.packagePath ?? "");
      setDirty(false);
      setSession(next.authSession ?? null);
      const notice = accountNotice.current;
      if (notice && notice.profileId === next.profile?.id) {
        setMessage(notice.message);
        setError(notice.error ?? "");
        accountNotice.current = null;
      }
      if (!profileId && next.profile) {
        const stored = useSettingsStore.getState().providers["kling-cli"];
        setProvider("kling-cli", { enabled: stored?.enabled ?? false, apiKey: "", authType: "cli-oauth", profileId: next.profile.id });
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && generation.current === current) setError(reason instanceof Error ? reason.message : "无法读取 Kling 设置");
    }).finally(() => { if (generation.current === current) setBusy(""); });
    return () => { controller.abort(); generation.current = current + 1; };
  }, [profileId, enabled, loadStatus, setProvider]);

  const sessionId = session?.id;
  const pollingLogin = Boolean(session && ACTIVE_LOGIN.has(session.state));
  useEffect(() => {
    if (!sessionId || !pollingLogin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = generation.current;
    const poll = async () => {
      try {
        const data = await readResponse<{ session: KlingAuthSession; authorizationUrl?: string }>(await klingFetch(`/api/integrations/kling/auth/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: "no-store" }));
        if (controller.signal.aborted || generation.current !== current) return;
        if (ACTIVE_LOGIN.has(data.session.state)) {
          setSession(data.session);
          setAuthorizationUrl(data.authorizationUrl ?? "");
          timer = setTimeout(poll, 2000);
        }
        else {
          setAuthorizationUrl("");
          const next = await loadStatus(profileId, controller.signal);
          if (controller.signal.aborted || generation.current !== current) return;
          setStatus(next);
          // Commit the terminal session after status loads; otherwise effect cleanup aborts this request.
          setSession(data.session);
          catalogChanged.current?.();
          setError(data.session.errorMessage ?? "");
        }
      } catch (reason) {
        if (!controller.signal.aborted && generation.current === current) {
          setError(reason instanceof Error ? reason.message : "登录状态暂时无法读取");
          timer = setTimeout(poll, 4000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, pollingLogin, profileId, loadStatus]);

  const perform = async (action: string, path: string, body: object) => {
    if (busy) return;
    const current = generation.current;
    setBusy(action); setError(""); setMessage("");
    try {
      const data = await readResponse<Record<string, unknown>>(await klingFetch(`/api/integrations/kling/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      if (generation.current !== current) return;
      if (action === "login") {
        setSession(data.session as KlingAuthSession);
        setMessage("请在打开的浏览器中授权。如未自动打开，请使用下方官方登录链接。");
        return;
      }
      const saved = data.profile as { id?: string } | undefined;
      const id = typeof data.profileId === "string" ? data.profileId : saved?.id ?? profileId;
      if (action === "add-account") {
        const created = data.profile as KlingPublicStatus["profile"];
        if (!id || !created) throw new Error("未能创建 Kling 账号，请重试。");
        let loginError = "";
        if (created.environmentState === "ready") {
          try {
            await readResponse(await klingFetch("/api/integrations/kling/auth/login", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profileId: id }),
            }));
          } catch (reason) { loginError = reason instanceof Error ? reason.message : "无法启动登录，请点击登录 Kling 重试。"; }
        }
        if (generation.current !== current) return;
        accountNotice.current = {
          profileId: id,
          message: created.environmentState === "ready" && !loginError
            ? "请在官方授权页切换到要添加的 Kling 账号并授权。如未自动打开，请使用下方官方登录链接。"
            : loginError ? "新账号已添加，请点击“登录 Kling”重试。" : "新账号配置已保存，请检测环境后登录 Kling。",
          error: loginError || created.environmentError,
        };
        const stored = useSettingsStore.getState().providers["kling-cli"];
        setProvider("kling-cli", { enabled: stored?.enabled ?? false, apiKey: "", authType: "cli-oauth", profileId: id });
        catalogChanged.current?.();
        return;
      }
      if (action === "save" && id) {
        setProvider("kling-cli", { enabled: provider?.enabled ?? false, apiKey: "", authType: "cli-oauth", profileId: id });
      }
      const next = await loadStatus(id);
      if (generation.current !== current) return;
      setStatus(next); setSession(next.authSession ?? null); setAuthorizationUrl("");
      if (action === "save") {
        setNodePath(next.profile?.nodePath ?? ""); setPackagePath(next.profile?.packagePath ?? ""); setDirty(false);
      }
      setMessage(action === "refresh" ? "账号、模型目录与积分已重新查询。" : action === "detect" ? "环境检测完成。" : action === "logout" ? "已退出此 ClipForge 配置的 Kling 登录。" : action === "cancel" ? "已停止本地登录。" : "配置已保存，请检测环境后登录。");
      catalogChanged.current?.();
    } catch (reason) {
      if (generation.current === current) {
        setError(reason instanceof Error ? reason.message : "Kling 操作失败");
        // A failed refresh may still revoke the previous login/catalog on the server.
        try {
          const next = await loadStatus(profileId);
          if (generation.current === current) { setStatus(next); catalogChanged.current?.(); }
        } catch { /* Keep the action's error when the local status is unavailable too. */ }
      }
    } finally { if (generation.current === current) setBusy(""); }
  };

  const profile = status?.profile;
  const locked = Boolean(busy || pollingLogin);
  const account = profile?.accountSummary;
  const savedProfiles = status?.profiles.filter((item) => !item.disabled) ?? [];
  return (
    <Card className="glass-card" id="kling-cli-settings">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Kling 官方 CLI</h3>
            <p className="text-xs text-muted-foreground">使用本机安装的官方 CLI 与 Kling 账号生成视频，支持单镜头生成和批量转动态。仅支持本机网页版，暂不支持 Electron。</p>
          </div>
          <ToggleSwitch
            checked={enabled}
            aria-label="启用 Kling 官方 CLI"
            onChange={(checked) => {
              setProvider("kling-cli", { enabled: checked, apiKey: "", authType: "cli-oauth", ...(profileId ? { profileId } : {}) });
              catalogChanged.current?.();
            }}
          />
        </div>

        <details className="rounded-md border border-border/50 p-3" open={!profile}>
          <summary className="cursor-pointer text-xs font-medium">安装与本机运行配置</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">双击启动脚本已准备好 CLI 时，路径会自动填写，依次保存本机配置、检测环境、登录 Kling 即可。手动启动时先安装固定版本：<code className="select-all">npm install -g {KLING_PACKAGE}@{KLING_VERSION}</code>。当前仅支持 Global 账号。</p>
            <div className="space-y-1.5"><Label htmlFor="kling-node-path">Node 可执行文件路径</Label><Input id="kling-node-path" value={nodePath} disabled={locked} onChange={(event) => { setNodePath(event.target.value); setDirty(true); }} placeholder="留空使用本机服务的 Node" className="font-mono text-xs" /></div>
            <div className="space-y-1.5"><Label htmlFor="kling-package-path">CLI 包目录</Label><Input id="kling-package-path" value={packagePath} disabled={locked} onChange={(event) => { setPackagePath(event.target.value); setDirty(true); }} placeholder="包含 package.json 与 dist/cli.js 的 @klingai/cli-global 目录" className="font-mono text-xs" /><p className="text-xs text-muted-foreground">可运行 npm root -g 查看全局包目录，再定位其中的 @klingai/cli-global 文件夹。请填写目录路径。</p></div>
            <Button size="sm" variant="outline" disabled={locked || !packagePath.trim()} onClick={() => void perform("save", "profiles", { ...(profileId ? { id: profileId } : {}), nodePath: nodePath.trim(), packagePath: packagePath.trim() })}>{busy === "save" ? "保存中…" : "保存本机配置"}</Button>
          </div>
        </details>

        {profile && <div className="space-y-2">
          <Label htmlFor="kling-profile">切换 Kling 账号</Label>
          <div className="flex flex-wrap gap-2">
            <select id="kling-profile" className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" disabled={locked || dirty} value={profileId ?? profile.id} onChange={(event) => {
              setProvider("kling-cli", { enabled: provider?.enabled ?? false, apiKey: "", authType: "cli-oauth", profileId: event.target.value });
              catalogChanged.current?.();
            }}>
              {savedProfiles.map((item) => <option key={item.id} value={item.id}>{item.accountSummary ? `${item.accountSummary.displayName ? `${item.accountSummary.displayName}（${item.accountSummary.id}）` : item.accountSummary.id}` : `${item.label} · ${item.id.slice(0, 8)}`} · {AUTH_LABELS[item.authState]}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={locked || dirty || profile.environmentState !== "ready"} onClick={() => void perform("add-account", "profiles", { sourceProfileId: profile.id })}>{busy === "add-account" ? "添加中…" : "添加并登录账号"}</Button>
          </div>
          <p className="text-xs text-muted-foreground">可随时切换已保存的账号；添加账号时请在官方授权页选择要使用的账号。已有任务继续使用提交时的账号。</p>
        </div>}

        <div aria-live="polite" className="space-y-1 text-xs">
          <p>运行环境：{busy === "status" ? "读取中…" : profile?.environmentState === "ready" ? `可用 · ${profile.cliPackage}@${profile.cliVersion}` : "尚未通过检测"}</p>
          {profile?.environmentError && <p className="text-amber-600 dark:text-amber-400">{profile.environmentError}</p>}
          <p>认证：{AUTH_LABELS[profile?.authState ?? "unknown"]}</p>
          {account && <p>{profile?.authState === "account_mismatch" ? "此配置绑定账号" : "账号"}：{account.displayName && account.displayName !== account.id ? `${account.displayName}（${account.id}）` : account.id}</p>}
          {profile?.authState === "account_mismatch" && <p className="text-amber-600 dark:text-amber-400">使用其他账号请点击“添加并登录账号”，或在上方切换已保存的账号。恢复原任务请登录此配置绑定的账号。</p>}
          {profile?.authState === "authenticated" && profile.creditsSummary && <p>官方积分信息：{Object.entries(profile.creditsSummary).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</p>}
          {profile?.authState === "authenticated" && profile.creditsError && <p className="text-muted-foreground">积分暂时无法读取：{profile.creditsError}</p>}
          {profile?.authState === "authenticated" && !profile.creditsSummary && !profile.creditsError && <p className="text-muted-foreground">积分信息尚未查询。生成费用以 Kling 官方账号为准。</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={locked || dirty || !profile} onClick={() => void perform("detect", "detect", { profileId: profile?.id })}>{busy === "detect" ? "检测中…" : "检测环境"}</Button>
          <Button size="sm" disabled={locked || dirty || profile?.environmentState !== "ready"} onClick={() => void perform("login", "auth/login", { profileId: profile?.id })}>{busy === "login" ? "启动中…" : profile?.authState === "account_mismatch" ? "登录原账号" : status?.loggedIn ? "重新登录" : "登录 Kling"}</Button>
          {pollingLogin && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void perform("cancel", `auth/sessions/${sessionId}/cancel`, {})}>停止登录</Button>}
          <Button size="sm" variant="outline" disabled={locked || dirty || profile?.environmentState !== "ready"} onClick={() => void perform("refresh", "refresh", { profileId: profile?.id })}>{busy === "refresh" ? "刷新中…" : "刷新账号与模型"}</Button>
          <Button size="sm" variant="outline" disabled={locked || dirty || !profile || profile.authState === "logged_out"} onClick={() => void perform("logout", "auth/logout", { profileId: profile?.id })}>退出登录</Button>
        </div>
        {dirty && <p className="text-xs text-amber-600 dark:text-amber-400">安装路径已修改，请先保存配置并重新检测。</p>}
        {session && <p role="status" className="text-xs">{LOGIN_LABELS[session.state] ?? session.state}</p>}
        {authorizationUrl && pollingLogin && <a className="inline-block text-xs text-primary underline" href={authorizationUrl} target="_blank" rel="noreferrer noopener">打开 Kling 官方授权页</a>}

        {status?.loggedIn && <div className="space-y-2 border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">{status.models.length ? `当前账号提供 ${status.models.length} 个视频模型。` : "当前账号没有可用视频模型，请刷新目录。"}在 <a className="text-primary underline" href="/settings?tab=video">视频生成 → 默认视频模型</a> 中统一选择 Kling 或方舟模型。</p>
          <p className="text-xs text-muted-foreground">单镜头生成与批量转动态使用同一个默认模型；已有镜头任务按提交时的模型查询和保存。</p>
        </div>}
        {message && <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">{message}</p>}
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
