import type { KlingConcurrencyStatus } from "./concurrency";

/** Shared, non-secret contracts for the fixed Kling Global CLI adapter. */
export const KLING_PACKAGE = "@klingai/cli-global";
export const KLING_VERSION = "0.2.0";
export const KLING_ADAPTER_VERSION = "1";
export const KLING_ENDPOINT = "https://kling.ai/mcp";
export type KlingTool = "text_to_video" | "image_to_video";
export type KlingEnvironmentState = "not_configured" | "not_found" | "invalid_package" | "unsupported_version" | "node_unavailable" | "ready";
export type KlingAuthState = "unknown" | "logged_out" | "logging_in" | "authenticated" | "reauth_required" | "account_mismatch";
export type KlingAuthSessionState = "queued" | "starting" | "waiting_browser" | "verifying" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface KlingParameter {
  name: string; required: boolean; type: "string" | "number" | "boolean";
  allowedValues?: Array<string | number | boolean>; default?: string | number | boolean; description?: string;
}
export interface KlingInputSlot { name: string; required: boolean; role: "image" | "tailImage"; }
export interface KlingVideoModelDescriptor {
  selectionKey: string; provider: "kling-cli"; profileId: string; region: "global";
  tool: KlingTool; remoteModelId: string; displayName: string; description?: string;
  catalogRevision: string; available: boolean; disabledReason?: string;
  parameters: KlingParameter[]; inputSlots: KlingInputSlot[];
  capabilities: { image: boolean; tailFrame: boolean; multiImage: boolean; audio: boolean };
}
export interface KlingAccountSummary { id: string; displayName?: string; }
export interface KlingProfile {
  id: string; label: string; region: "global"; cliPackage: string; cliVersion: string; adapterVersion: string;
  nodePath: string; packagePath: string; cliEntry: string; homePath: string; endpoint: string;
  environmentState: KlingEnvironmentState; environmentError?: string; environmentCheckedAt?: number;
  authState: KlingAuthState; authRevision: number; principalKey?: string; accountSummary?: KlingAccountSummary;
  catalogSnapshot: KlingVideoModelDescriptor[]; catalogRevision?: string; catalogCheckedAt?: number;
  accountCheckedAt?: number; creditsSummary?: Record<string, string | number | boolean>; creditsError?: string;
  disabledAt?: number; createdAt: number; updatedAt: number;
}
export interface KlingAuthSession {
  id: string; profileId: string; state: KlingAuthSessionState; startedAt: number; deadlineAt: number;
  finishedAt?: number; runnerOwner: string; errorCode?: string; errorMessage?: string;
  cancelRequestedAt?: number;
}
export interface KlingCliResult {
  exitCode: number | null; signal: string | null; json?: unknown; generationId?: string;
  /** Internal diagnostics only: never forward these unfiltered to a browser. */
  stdout: string; stderr: string; timedOut: boolean; aborted: boolean;
  /** True only when the child never emitted a successful spawn event. */
  spawnFailed?: boolean;
}
export interface KlingRunOptions {
  timeoutMs?: number; signal?: AbortSignal; interactiveLogin?: boolean; allowFailure?: boolean;
  lease?: KlingLease; beforeSpawn?: () => void; onSpawn?: (pid: number) => void; onStderr?: (chunk: string) => void;
  onGenerationId?: (id: string) => void;
}
export interface KlingLease { profileId: string; owner: string; token: number; assertOwned(): void; }
export interface KlingNormalizedWork { id: string; url: string; watermarkFreeUrl?: string; }
export interface KlingNormalizedTask {
  generationId?: string; status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
  rawStatus: string; works: KlingNormalizedWork[]; error?: string;
}
export interface KlingPublicStatus {
  profile: Omit<KlingProfile, "homePath"> | null; profiles: Array<{ id: string; label: string; authState: KlingAuthState; disabled: boolean; accountSummary?: KlingAccountSummary }>;
  configured: boolean; loggedIn: boolean; models: KlingVideoModelDescriptor[]; authSession?: KlingAuthSession;
  concurrency?: KlingConcurrencyStatus;
  installationDefaults?: { nodePath: string; packagePath: string };
}
