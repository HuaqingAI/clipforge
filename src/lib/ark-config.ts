/** Shared Ark endpoints. The selected access mode is persisted in the existing base URL. */
export const ARK_STANDARD_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const ARK_AGENT_PLAN_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'

export function normalizeArkBaseUrl(baseUrl?: string): string {
  return baseUrl?.trim().replace(/\/+$/, '') || ARK_STANDARD_BASE_URL
}

/** Match the API path so AgentPlan also works through a user-supplied proxy host. */
export function isArkAgentPlanBase(baseUrl?: string): boolean {
  try {
    return new URL(normalizeArkBaseUrl(baseUrl)).pathname === '/api/plan/v3'
  } catch {
    return false
  }
}
