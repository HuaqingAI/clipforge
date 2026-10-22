import { NextRequest, NextResponse } from "next/server";
import { normalizeChatBase } from "@/lib/llm-models";
import { ARK_STANDARD_BASE_URL, isArkAgentPlanBase, normalizeArkBaseUrl } from "@/lib/ark-config";
import { normalizeOpenAIBaseUrl } from "@/lib/openai-config";
import { errText } from "@/lib/api-error";

/**
 * AI 平台 Key 连通性校验（生图/生视频平台）。
 * 各平台用最便宜的「鉴权先过」端点探针：
 * - 2xx → ok（Key 有效）
 * - 401/403 → invalid（Key 无效）
 * - 其它(404/400/5xx/网络) → unknown（无法判定，可直接试生成）
 * 走服务端发起，绕开浏览器 CORS；只读探针，不产生计费生成。
 */

const DEFAULT_BASE: Record<string, string> = {
  "atlas-cloud": "https://api.atlascloud.ai/api/v1",
  "fal-ai": "https://queue.fal.run",
  replicate: "https://api.replicate.com/v1",
  volcengine: ARK_STANDARD_BASE_URL,
  alibaba: "https://dashscope.aliyuncs.com/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  openai: "https://api.openai.com/v1",
};

type Probe = { url: string; headers: Record<string, string>; authFirst?: boolean; method?: "GET" | "POST"; body?: string };

function buildProbe(name: string, apiKey: string, baseUrl?: string): Probe {
  const base = name === "volcengine"
    ? normalizeArkBaseUrl(baseUrl)
    : name === "openai"
      ? normalizeOpenAIBaseUrl(baseUrl)
    : (baseUrl || DEFAULT_BASE[name] || "").replace(/\/$/, "");
  if (name === "volcengine" && isArkAgentPlanBase(base)) {
    // AgentPlan has no /models endpoint. Listing tasks validates credentials without
    // creating a video or consuming generation quota.
    return { url: `${base}/contents/generations/tasks?page_size=1`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  if (name === "fal-ai") {
    // fal 先校验鉴权再解析 request id：到达 404/422 即说明 Key 有效
    return {
      url: `${base}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`,
      headers: { Authorization: `Key ${apiKey}` },
      authFirst: true,
    };
  }
  if (name === "replicate") {
    return { url: `${base}/account`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  if (name === "alibaba") {
    // dashscope 原生无 /models，用 OpenAI 兼容模式的 /models 验 Key
    return { url: `https://dashscope.aliyuncs.com/compatible-mode/v1/models`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
  if (name === "atlas-cloud") {
    // Atlas 的 GET /models 是公开模型目录，无效 Key 也返回 2xx（会误判为有效）。
    // Atlas 没有 /account、/me、/usage 这类只读鉴权端点，只能用 OpenAI 兼容的 chat/completions 做鉴权探针：
    // 选最便宜的聊天模型 + max_tokens:1，仅靠 401/403 判无效，2xx 即鉴权通过；成本/时延可忽略。
    // 必须打聊天网关 /v1：素材网关 /api/v1 上的 chat/completions 对有效 Key 也只回 404，
    // 于是「有效」被降级成「无法判定」，Key 明明能用却从来没被确认过（issue #24）。
    return {
      url: `${normalizeChatBase(base)}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify({
        // non-thinking flash tier: a thinking model can burn reasoning tokens even at max_tokens:1
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    };
  }
  // siliconflow / volcengine / 自定义 OpenAI 兼容：GET /models
  return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function POST(req: NextRequest) {
  let body: { name?: string; apiKey?: string; baseUrl?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body */
  }
  const { name, apiKey, baseUrl } = body;
  if (!name || !apiKey) {
    return NextResponse.json({ status: "unknown", message: "缺少平台或 Key" }, { status: 400 });
  }

  const probe = buildProbe(name, apiKey, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(probe.url, { method: probe.method ?? "GET", headers: probe.headers, body: probe.body, signal: controller.signal });
    if (name === "volcengine") {
      const agentPlan = isArkAgentPlanBase(baseUrl);
      if (r.status === 401 || r.status === 403) {
        return NextResponse.json({ status: "invalid", message: agentPlan
          ? errText(req, "AgentPlan 套餐 Key 无效或无权限，请检查套餐状态，以及 Key 是否对应 /api/plan/v3 接口。", "AgentPlan rejected this key or its permissions. Check your plan status and use the plan key with /api/plan/v3.")
          : errText(req, "方舟 Key 无效或无权限，请检查项目权限；AgentPlan 套餐 Key 请切换到 AgentPlan 模式（/api/plan/v3）。", "Ark rejected this key or its project permissions. For an AgentPlan key, select AgentPlan mode (/api/plan/v3).") });
      }
      if (agentPlan) {
        return NextResponse.json({ status: r.ok ? "ok" : "unknown", message: r.ok
          ? errText(req, "AgentPlan 连接正常，任务查询鉴权通过；具体视频模型与额度以生成时为准。", "AgentPlan connection verified through authenticated task listing. Video model access and quota are checked when generating.")
          : errText(req, `无法判定 AgentPlan 连接（HTTP ${r.status}），请检查套餐 Key 和 /api/plan/v3 接口地址。`, `AgentPlan connection could not be verified (HTTP ${r.status}). Check the plan key and /api/plan/v3 Base URL.`) });
      }
      return NextResponse.json({
        status: "unknown",
        message: r.ok
          ? "Ark is reachable. This model-list probe does not verify Seedream/Seedance generation permissions. Check the selected model and this API key's project access in the Ark console."
          : `Generation permissions could not be verified (HTTP ${r.status}). Check the Ark API key, project access and Base URL: ${ARK_STANDARD_BASE_URL}. For an AgentPlan key, select AgentPlan mode (/api/plan/v3).`,
      });
    }
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({ status: "invalid", message: "Key 无效或无权限" });
    }
    if (name === "openai") {
      const addressHint = errText(req,
        "请检查 Base URL 是否为 OpenAI 兼容 API 地址（通常以 /v1 结尾），不要填写网站首页。",
        "Check that the Base URL points to the OpenAI-compatible API (usually ending in /v1), rather than the website homepage.");
      if (!r.ok) {
        return NextResponse.json({ status: "unknown", message: errText(req,
          `无法验证模型列表访问（HTTP ${r.status}）。${addressHint}`,
          `Model-list access could not be verified (HTTP ${r.status}). ${addressHint}`) });
      }
      let models: unknown;
      try {
        models = await r.json();
      } catch {
        return NextResponse.json({ status: "unknown", message: errText(req,
          `接口未返回有效的模型列表 JSON。${addressHint}`,
          `The endpoint did not return valid model-list JSON. ${addressHint}`) });
      }
      const data = models && typeof models === "object" && "data" in models ? models.data : undefined;
      if (!Array.isArray(data) || data.length === 0) {
        return NextResponse.json({ status: "unknown", message: errText(req,
          `接口未返回有效的模型列表。${addressHint}`,
          `The endpoint did not return a valid model list. ${addressHint}`) });
      }
      return NextResponse.json({ status: "ok", message: errText(req,
        "模型列表访问正常；此检查仅验证模型列表访问，尚未验证图片编辑接口 /images/edits 或所选模型的调用权限。",
        "Model-list access verified. This check does not verify image editing at /images/edits or access to the selected model.") });
    }
    if (r.ok || probe.authFirst) {
      // authFirst 平台：非 401/403 即视为鉴权通过
      return NextResponse.json({ status: "ok", message: "连接正常" });
    }
    return NextResponse.json({ status: "unknown", message: `无法判定（HTTP ${r.status}），可直接试生成` });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return NextResponse.json({ status: "unknown", message: aborted ? "超时，无法判定" : "网络异常，无法判定" });
  } finally {
    clearTimeout(timer);
  }
}
