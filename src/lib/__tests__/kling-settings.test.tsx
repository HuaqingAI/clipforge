import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KlingCliSettings } from "@/components/settings/kling-cli-settings";
import { useSettingsStore } from "@/lib/stores/settings-store";
import type { KlingAuthSession, KlingPublicStatus } from "@/lib/kling/types";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kling/client", () => ({ klingFetch: request, klingErrorMessage: (body: { error?: string }, fallback: string) => body?.error || fallback }));

let root: Root;
let container: HTMLDivElement;
let status: KlingPublicStatus;
const initial = useSettingsStore.getInitialState();
const profileId = "11111111-1111-1111-1111-111111111111";
const otherProfileId = "22222222-2222-2222-2222-222222222222";
const login: KlingAuthSession = { id: "login-1", profileId, state: "waiting_browser", startedAt: 1, deadlineAt: 2, runnerOwner: "owner" };

function button(label: string): HTMLButtonElement { return [...container.querySelectorAll("button")].find((item) => item.textContent === label)!; }
function accountSelect(): HTMLSelectElement { return container.querySelector("#kling-profile")!; }
function postedRequests() { return request.mock.calls.filter(([, options]) => options?.method === "POST").map(([url, options]) => ({ url, body: JSON.parse(options.body) })); }
async function render() { await act(async () => root.render(createElement(KlingCliSettings))); }

function accountStatus(id: string, authState: NonNullable<KlingPublicStatus["profile"]>["authState"], accountId?: string, displayName?: string): KlingPublicStatus {
  return {
    configured: true, loggedIn: authState === "authenticated", models: [], profiles: [],
    profile: { ...status.profile!, id, label: "Kling Global", authState, ...(accountId ? { accountSummary: { id: accountId, displayName } } : {}) },
  };
}

function mockAccounts(accounts: KlingPublicStatus[], options: { created?: KlingPublicStatus; createError?: string; loginError?: string } = {}) {
  const saved = new Map(accounts.map((account) => [account.profile!.id, account]));
  request.mockImplementation(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, "http://localhost");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (parsed.pathname.endsWith("/profiles") && init?.method === "POST") {
      if (options.createError) return Response.json({ error: options.createError }, { status: 409 });
      const created = options.created!;
      saved.set(created.profile!.id, created);
      return Response.json({ profileId: created.profile!.id, profile: created.profile });
    }
    if (parsed.pathname.endsWith("/auth/login")) {
      if (options.loginError) return Response.json({ error: options.loginError }, { status: 409 });
      const account = saved.get(body.profileId)!;
      account.profile!.authState = "logging_in";
      account.authSession = { ...login, id: `login-${body.profileId}`, profileId: body.profileId };
      return Response.json({ authSessionId: account.authSession.id, session: account.authSession }, { status: 202 });
    }
    if (parsed.pathname.includes("/auth/sessions/")) {
      const account = [...saved.values()].find((item) => item.authSession?.id === parsed.pathname.split("/").at(-1))!;
      return Response.json({ session: account.authSession, authorizationUrl: "https://kling.ai/authorize?state=example" });
    }
    const account = saved.get(parsed.searchParams.get("profileId") ?? profileId)!;
    return Response.json({ ...account, profiles: [...saved.values()].map((item) => ({ id: item.profile!.id, label: item.profile!.label, authState: item.profile!.authState, accountSummary: item.profile!.accountSummary, disabled: false })) });
  });
  return saved;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  status = { configured: true, loggedIn: false, models: [], profiles: [], profile: { id: profileId, nodePath: "C:/node/node.exe", packagePath: "C:/packages/@klingai/cli-global", cliPackage: "@klingai/cli-global", cliVersion: "0.2.0", environmentState: "ready", authState: "logged_out" } as KlingPublicStatus["profile"] };
  request.mockImplementation(async (url: string) => {
    if (url.includes("/auth/login")) return Response.json({ authSessionId: login.id, session: login }, { status: 202 });
    if (url.includes("/cancel")) { status.authSession = { ...login, state: "cancelled" }; return Response.json({}); }
    if (url.includes("/auth/sessions/")) return Response.json({ session: login, authorizationUrl: "https://kling.ai/authorize?state=example" });
    return Response.json(status);
  });
  useSettingsStore.setState({ ...initial, providers: { "kling-cli": { enabled: true, apiKey: "", authType: "cli-oauth", profileId } } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useSettingsStore.setState(initial); vi.unstubAllGlobals(); });

describe("Kling local settings", () => {
  it("does not invoke local integrations until a new provider is enabled or configured", async () => {
    useSettingsStore.setState({ providers: {} });
    await render();
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("@klingai/cli-global@0.2.0");
  });

  it("prefills launcher paths only after enabling Kling and waits for explicit setup actions", async () => {
    useSettingsStore.setState({ providers: {} });
    const installationDefaults = { nodePath: "C:/ClipForge tools/node.exe", packagePath: "C:/ClipForge tools/@klingai/cli-global" };
    status = { profile: null, profiles: [], configured: false, loggedIn: false, models: [], installationDefaults };
    await render();
    expect(request).not.toHaveBeenCalled();
    expect((container.querySelector("#kling-package-path") as HTMLInputElement).value).toBe("");

    await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());

    expect((container.querySelector("#kling-node-path") as HTMLInputElement).value).toBe(installationDefaults.nodePath);
    expect((container.querySelector("#kling-package-path") as HTMLInputElement).value).toBe(installationDefaults.packagePath);
    expect(container.textContent).toContain("路径会自动填写");
    expect(button("保存本机配置").disabled).toBe(false);
    expect(button("检测环境").disabled).toBe(true);
    expect(button("登录 Kling").disabled).toBe(true);
    expect(postedRequests()).toEqual([]);
    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBeUndefined();

    const input = container.querySelector("#kling-package-path") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "D:/chosen-cli");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render();
    expect(input.value).toBe("D:/chosen-cli");
    expect(postedRequests()).toEqual([]);
  });

  it("keeps saved installation paths when launcher defaults are also supplied", async () => {
    status.installationDefaults = { nodePath: "D:/launcher/node.exe", packagePath: "D:/launcher/kling" };
    await render();
    expect((container.querySelector("#kling-node-path") as HTMLInputElement).value).toBe(status.profile!.nodePath);
    expect((container.querySelector("#kling-package-path") as HTMLInputElement).value).toBe(status.profile!.packagePath);
    expect(postedRequests()).toEqual([]);
  });

  it("starts and stops only a local login session, with no generation request", async () => {
    await render();
    await act(async () => button("登录 Kling").click());
    expect(container.textContent).toContain("请在浏览器完成官方授权");
    expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://kling.ai/authorize?state=example");
    await act(async () => button("停止登录").click());
    expect(container.textContent).toContain("登录已停止");
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(request.mock.calls.every(([url]) => !String(url).includes("/video"))).toBe(true);
    expect(useSettingsStore.getState().providers["kling-cli"].apiKey).toBe("");
  });

  it("disables stale environment actions after the path is edited", async () => {
    await render();
    const input = container.querySelector("#kling-package-path") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "D:/other-package");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("登录 Kling").disabled).toBe(true);
    expect(button("检测环境").disabled).toBe(true);
    expect(button("保存本机配置").disabled).toBe(false);
    expect(accountSelect().disabled).toBe(true);
    expect(button("添加并登录账号").disabled).toBe(true);
  });

  it("adds a separate account from an account mismatch without logging out or rebinding the original", async () => {
    const original = accountStatus(profileId, "account_mismatch", "94171213", "原账号");
    original.profile!.creditsSummary = { balance: 123456 };
    original.profile!.creditsError = "stale credit error";
    const created = accountStatus(otherProfileId, "logged_out");
    mockAccounts([original], { created });
    await render();
    expect(container.textContent).toContain("此配置绑定账号：原账号（94171213）");
    expect(container.textContent).toContain("恢复原任务请登录此配置绑定的账号");
    expect(container.textContent).not.toContain("123456");
    expect(container.textContent).not.toContain("stale credit error");
    expect(button("登录原账号").disabled).toBe(false);

    await act(async () => button("添加并登录账号").click());

    expect(postedRequests()).toEqual([
      { url: "/api/integrations/kling/profiles", body: { sourceProfileId: profileId } },
      { url: "/api/integrations/kling/auth/login", body: { profileId: otherProfileId } },
    ]);
    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(otherProfileId);
    expect(original.profile!.accountSummary).toEqual({ id: "94171213", displayName: "原账号" });
    expect(original.profile!.authState).toBe("account_mismatch");
    expect(container.textContent).toContain("请在官方授权页切换到要添加的 Kling 账号并授权");
    expect(container.textContent).toContain("请在浏览器完成官方授权");
    expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://kling.ai/authorize?state=example");
  });

  it("switches saved accounts and reloads their status without issuing an authentication command", async () => {
    mockAccounts([
      accountStatus(profileId, "account_mismatch", "94171213", "原账号"),
      accountStatus(otherProfileId, "authenticated", "other-account", "工作账号"),
    ]);
    await render();
    expect([...accountSelect().options].map((option) => option.textContent)).toEqual([
      "原账号（94171213） · 账号不一致，原任务需使用原账号恢复",
      "工作账号（other-account） · 已登录",
    ]);

    await act(async () => {
      accountSelect().value = otherProfileId;
      accountSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(otherProfileId);
    expect(accountSelect().value).toBe(otherProfileId);
    expect(container.textContent).toContain("账号：工作账号（other-account）");
    expect(container.textContent).toContain("认证：已登录");
    expect(request).toHaveBeenCalledWith(`/api/integrations/kling/status?profileId=${otherProfileId}`, expect.objectContaining({ cache: "no-store" }));
    expect(postedRequests()).toEqual([]);
  });

  it("locks account changes while an existing login is awaiting authorization", async () => {
    const original = accountStatus(profileId, "logging_in", "94171213");
    original.authSession = login;
    mockAccounts([original, accountStatus(otherProfileId, "authenticated", "other-account")]);
    await render();
    expect(accountSelect().disabled).toBe(true);
    expect(button("添加并登录账号").disabled).toBe(true);
    expect(button("停止登录").disabled).toBe(false);
    expect(postedRequests()).toEqual([]);
  });

  it("locks account changes until adding an account has finished", async () => {
    mockAccounts([accountStatus(profileId, "account_mismatch", "94171213")], { created: accountStatus(otherProfileId, "logged_out") });
    const backend = request.getMockImplementation()!;
    let finishCreating!: () => void;
    const creating = new Promise<void>((resolve) => { finishCreating = resolve; });
    request.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/profiles") && options?.method === "POST") await creating;
      return backend(url, options);
    });
    await render();
    await act(async () => button("添加并登录账号").click());

    expect(accountSelect().disabled).toBe(true);
    expect(button("添加中…").disabled).toBe(true);
    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(profileId);
    await act(async () => { finishCreating(); });
    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(otherProfileId);
    expect(container.textContent).toContain("请在浏览器完成官方授权");
  });

  it("finishes a login only after its refreshed account status has loaded", async () => {
    status.profile!.authState = "logging_in";
    status.authSession = login;
    const completed = accountStatus(profileId, "authenticated", "94171213", "已授权账号");
    completed.authSession = { ...login, state: "succeeded" };
    completed.models = [{ provider: "kling-cli", selectionKey: "official-model", profileId, region: "global", tool: "image_to_video", remoteModelId: "official-model", displayName: "Official", catalogRevision: "rev", available: true, parameters: [], inputSlots: [], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } }];
    let resolveStatus!: (response: Response) => void;
    const refreshedStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    let statusSignal: AbortSignal | null | undefined;
    let reads = 0;
    request.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/auth/sessions/")) return Response.json({ session: completed.authSession });
      if (++reads === 1) return Response.json(status);
      statusSignal = options?.signal;
      return refreshedStatus;
    });
    await render();

    expect(reads).toBe(2);
    expect(statusSignal?.aborted).toBe(false);
    expect(accountSelect().disabled).toBe(true);
    await act(async () => { resolveStatus(Response.json(completed)); });

    expect(container.textContent).toContain("认证：已登录");
    expect(container.textContent).toContain("账号：已授权账号（94171213）");
    expect(container.textContent).toContain("当前账号提供 1 个视频模型");
    expect(container.textContent).toContain("登录成功");
    expect(accountSelect().disabled).toBe(false);
  });

  it("keeps the original account selected and allows retry after account creation fails", async () => {
    mockAccounts([accountStatus(profileId, "account_mismatch", "94171213")], { createError: "无法保存新账号配置" });
    await render();
    await act(async () => button("添加并登录账号").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法保存新账号配置");
    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(profileId);
    expect(accountSelect().value).toBe(profileId);
    expect(accountSelect().disabled).toBe(false);
    expect(button("添加并登录账号").disabled).toBe(false);
    expect(postedRequests()).toEqual([{ url: "/api/integrations/kling/profiles", body: { sourceProfileId: profileId } }]);
  });

  it("keeps a newly saved account usable when starting its login fails", async () => {
    const original = accountStatus(profileId, "account_mismatch", "94171213");
    const options = { created: accountStatus(otherProfileId, "logged_out"), loginError: "浏览器无法启动，请重试登录" };
    mockAccounts([original], options);
    await render();
    await act(async () => button("添加并登录账号").click());

    expect(useSettingsStore.getState().providers["kling-cli"].profileId).toBe(otherProfileId);
    expect(accountSelect().value).toBe(otherProfileId);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("浏览器无法启动，请重试登录");
    expect(button("登录 Kling").disabled).toBe(false);
    expect(accountSelect().disabled).toBe(false);
    expect(original.profile!.authState).toBe("account_mismatch");
    expect(original.profile!.accountSummary?.id).toBe("94171213");

    options.loginError = "";
    await act(async () => button("登录 Kling").click());
    expect(container.textContent).toContain("请在浏览器完成官方授权");
    expect(postedRequests().at(-1)).toEqual({ url: "/api/integrations/kling/auth/login", body: { profileId: otherProfileId } });
  });

  it("links to the single default-model setting without changing the selected model", async () => {
    const key = JSON.stringify(["kling-cli", "image_to_video", "same-model"]);
    status.loggedIn = true;
    status.profile!.authState = "authenticated";
    status.models = [{ provider: "kling-cli", selectionKey: key, profileId, region: "global", tool: "image_to_video", remoteModelId: "same-model", displayName: "Official", catalogRevision: "rev", available: true, parameters: [], inputSlots: [], capabilities: { image: true, tailFrame: false, multiImage: false, audio: false } }];
    useSettingsStore.setState({ defaultVideoModel: "doubao-seedance-2.5" });
    await render();
    expect(container.textContent).toContain("积分信息尚未查询");
    expect(container.querySelector("#kling-default-model")).toBeNull();
    expect(container.querySelector('a[href="/settings?tab=video"]')).toBeTruthy();
    expect(container.textContent).toContain("单镜头与整片自动编排使用同一个默认模型");
    expect(useSettingsStore.getState().defaultVideoModel).toBe("doubao-seedance-2.5");
  });
});
