/** Browser-safe public contracts. Credentials and signed provider URLs never belong here. */
export type KlingSubmissionState = "prepared" | "submitting" | "acknowledged" | "not_submitted" | "submission_unknown";
export type KlingRemoteState = "not_started" | "pending" | "processing" | "completed" | "failed" | "cancelled" | "unknown";
export type KlingImportState = "not_ready" | "pending" | "importing" | "completed" | "partial" | "failed";
export interface KlingSubmissionDiagnostics {
  phase: "startup" | "upload" | "validation" | "submission";
  outcome: "not_submitted" | "unknown";
  reason: string;
  source: "cli" | "platform" | "process";
  exitCode?: number | null;
  timedOut: boolean;
  aborted: boolean;
  httpStatus?: number;
  remoteCode?: string;
  localCode?: string;
}
/** CLI output is redacted before persistence and before crossing the local API boundary. */
export interface KlingCliDiagnostics {
  recordedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  spawnFailed: boolean;
  stdout: string;
  stderr: string;
  responseJson?: string;
  error?: string;
  truncated: boolean;
  submission?: KlingSubmissionDiagnostics;
}
export interface KlingJobOutputView {
  outputId: string;
  assetId?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  imported: boolean;
  selected: boolean;
  selectionOutcome?: "selected" | "kept_as_alternative" | "detached";
}
export interface KlingJobView {
  jobId: string;
  profileId: string;
  accountLabel?: string;
  projectId: string;
  scriptId: string;
  shotId: number;
  modelId: string;
  tool: "text_to_video" | "image_to_video";
  prompt: string;
  remoteGenerationId?: string;
  submissionState: KlingSubmissionState;
  remoteState: KlingRemoteState;
  importState: KlingImportState;
  blockedReason?: string;
  lastError?: { code: string; message: string; retryable: boolean };
  cliDiagnostics?: KlingCliDiagnostics;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
  outputs: KlingJobOutputView[];
  allowedActions: string[];
  autoQueryPaused: boolean;
  needsConfirmation: boolean;
  inputSummary: Array<{ role: string; sourceUrl?: string; hash: string }>;
  options: Record<string, unknown>;
}
export interface KlingSubmitRequest {
  provider: "kling-cli";
  profileId: string;
  clientRequestId: string;
  executionScope: "single-shot";
  projectId: string;
  scriptId: string;
  shotId: number;
  selectionKey: string;
  mode: "text-to-video" | "image-to-video";
  prompt: string;
  imageUrl?: string;
  lastImageUrl?: string;
  referenceImageUrls?: string[];
  options?: Record<string, unknown>;
  expectedSelectedAssetId?: string | null;
  billingAcknowledgement: { policyRevision: "credits-v1"; acceptedForRequestId: string };
}
