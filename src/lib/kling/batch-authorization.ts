import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects, scripts } from "@/lib/db/schema";
import { generationItems, generationRuns } from "@/lib/generation-schema";
import { decryptGenerationValue, encryptGenerationValue } from "@/lib/generation-secrets";
import { generationContextItemId, generationContextSnapshot } from "@/lib/generation-context";
import { assertGenerationInputs, GenerationInputError } from "@/lib/generation-inputs";
import { projectGenerationSignature } from "@/lib/generation-source-context";
import type { GenerationPayload } from "@/lib/generation-types";
import { scriptRevision, type ScriptContext } from "@/lib/asset-context";
import { resolveCurrentScript } from "@/lib/current-script";
import { contentHash, canonicalJson } from "./inputs";
import { getProfile } from "./profiles";
import { KlingError } from "./errors";
import type { KlingJob, KlingJobData } from "./job-schema";
import type { KlingSubmitRequest } from "./job-types";

export const KLING_SUBMISSION_AUTHORIZATION_MS = 600_000;

type Store = Pick<ReturnType<typeof getDb>, "select">;
type BatchJob = Pick<KlingJob, "id" | "profileId" | "principalKey" | "region" | "projectId" | "scriptId" | "shotId" | "clientRequestId" | "data">;
type Authorization = NonNullable<KlingJobData["batchAuthorization"]>;

function invalid(): never {
  throw new KlingError("KLING_BATCH_AUTHORIZATION_INVALID", "原批次已停止或排队时确认的内容已变化，已阻止首次付费提交。请核对原任务。", 409);
}

/** Deliberately exclude changing leases, polling, diagnostics and authorization deadlines. */
function jobPayloadHash(job: BatchJob): string {
  const { model, prompt, options, inputs, args, requestHash, scriptRevision, shotKey, expectedSelectedAssetId,
    videoPromptAudit, promptContext, generationPlan, generationProjectSignature } = job.data;
  return contentHash({ profileId: job.profileId, principalKey: job.principalKey, region: job.region, projectId: job.projectId,
    scriptId: job.scriptId, shotId: job.shotId, clientRequestId: job.clientRequestId,
    model: { ...model, catalogRevision: "" }, prompt, options, inputs, args, requestHash, scriptRevision, shotKey, expectedSelectedAssetId,
    videoPromptAudit, promptContext, generationPlan, generationProjectSignature });
}

function activeBatch(job: BatchJob, store: Store, allowAttention = false) {
  if (!job.data.generationItemId || job.data.generationItemId !== job.clientRequestId) return invalid();
  const item = store.select().from(generationItems).where(eq(generationItems.id, job.data.generationItemId)).get();
  const run = item && store.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
  if (!item || !run || run.kind !== "video_batch" || run.cancelRequested || run.deletedAt !== null
    || item.kind !== "video" || !(["queued", "running", "waiting"].includes(item.status)
      || item.status === "needs_attention" && (allowAttention || job.data.batchAuthorization?.continuationEpoch === job.data.authorizationEpoch
        && job.data.authorizationEpoch > 1))
    || item.projectId !== job.projectId || run.projectId !== job.projectId || item.scriptId !== job.scriptId || item.shotId !== job.shotId) return invalid();
  const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
  if (checkpoint.blockingReleasedAt || checkpoint.cancelledBeforeSubmission || checkpoint.completedResult || checkpoint.remoteTaskId || checkpoint.taskId
    || checkpoint.childJobId && checkpoint.childJobId !== job.id || item.result?.childJobId && item.result.childJobId !== job.id
    || checkpoint.submissionState && !["prepared", "not_started"].includes(String(checkpoint.submissionState))) return invalid();
  const payload = decryptGenerationValue<GenerationPayload>(item.payload);
  const frozen = payload.snapshot?.kling;
  if (payload.request.provider !== "kling-cli" || payload.request.profileId !== job.profileId || payload.request.selectionKey !== job.data.model.selectionKey
    || !frozen || frozen.profileId !== job.profileId || frozen.principalKey !== job.principalKey || frozen.region !== job.region
    || canonicalJson({ ...frozen.model, catalogRevision: "" }) !== canonicalJson({ ...job.data.model, catalogRevision: "" })) return invalid();
  return { item, run, payload };
}

/** Browser fields cannot grant this authorization: require the real, leased worker and durable request. */
export function createKlingBatchAuthorization(job: BatchJob, request: KlingSubmitRequest, normalizeRequest: (raw: unknown) => KlingSubmitRequest, store: Store): Authorization | undefined {
  const itemId = generationContextItemId();
  if (!itemId) return undefined;
  const item = store.select().from(generationItems).where(eq(generationItems.id, itemId)).get();
  const run = item && store.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
  // Other durable generation kinds retain the ordinary single-shot deadline.
  if (run?.kind !== "video_batch") return undefined;
  const bound = activeBatch(job, store);
  if (bound.item.status !== "running" || !bound.item.leaseOwner?.startsWith(`${process.pid}:`)
    || !bound.item.leaseExpiresAt || bound.item.leaseExpiresAt <= Date.now()
    || canonicalJson(bound.payload.snapshot) !== canonicalJson(generationContextSnapshot())) return invalid();
  const accepted = normalizeRequest({ ...bound.payload.request, projectId: bound.item.projectId, scriptId: bound.item.scriptId, shotId: bound.item.shotId,
    clientRequestId: itemId, billingAcknowledgement: { policyRevision: "credits-v1", acceptedForRequestId: itemId } });
  if (canonicalJson(accepted) !== canonicalJson(request)) return invalid();
  return { runId: bound.run.id, runRequestHash: bound.run.requestHash, itemPayloadHash: contentHash(bound.item.payload), jobPayloadHash: jobPayloadHash(job) };
}

/** Must also run in the immediate paid-dispatch claim, even when the short deadline has not expired. */
export function assertKlingBatchAuthorization(job: BatchJob, store: Store = getDb(), allowAttention = false): void {
  const authorization = job.data.batchAuthorization;
  if (!authorization) {
    // Older worker children receive no renewable consent, but their original batch may still revoke submission.
    const item = job.data.generationItemId ? store.select().from(generationItems).where(eq(generationItems.id, job.data.generationItemId)).get() : undefined;
    const run = item && store.select().from(generationRuns).where(eq(generationRuns.id, item.runId)).get();
    if (item && run?.kind === "video_batch") {
      const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
      if (item.id !== job.clientRequestId || item.kind !== "video" || item.projectId !== job.projectId || run.projectId !== job.projectId
        || item.scriptId !== job.scriptId || item.shotId !== job.shotId || run.cancelRequested || run.deletedAt !== null
        || item.status === "cancelled" || item.stage === "released" || checkpoint.blockingReleasedAt || checkpoint.cancelledBeforeSubmission
        || checkpoint.childJobId && checkpoint.childJobId !== job.id || item.result?.childJobId && item.result.childJobId !== job.id) return invalid();
    }
    return;
  }
  if (job.data.deletedAt || job.data.blockingReleasedAt || job.data.filmRunId) return invalid();
  const { item, run, payload } = activeBatch(job, store, allowAttention);
  if (authorization.runId !== run.id || authorization.runRequestHash !== run.requestHash
    || authorization.itemPayloadHash !== contentHash(item.payload) || authorization.jobPayloadHash !== jobPayloadHash(job)) return invalid();
  const profile = getProfile(job.profileId);
  const model = profile.catalogSnapshot.find((model) => model.selectionKey === job.data.model.selectionKey);
  if (profile.disabledAt || profile.environmentState !== "ready" || profile.authState !== "authenticated"
    || profile.principalKey !== job.principalKey || profile.region !== job.region || !model
    || canonicalJson({ ...model, catalogRevision: "" }) !== canonicalJson({ ...job.data.model, catalogRevision: "" })) return invalid();
  const project = store.select().from(projects).where(eq(projects.id, job.projectId)).get();
  const current = resolveCurrentScript(store.select().from(scripts).where(eq(scripts.projectId, job.projectId)).all());
  const frozenProject = payload.snapshot?.project;
  const frozenScript = payload.snapshot?.script as unknown as ScriptContext | undefined;
  if (!project || !current || current.id !== job.scriptId || !current.shots?.some((shot) => shot.shotId === job.shotId)
    || !frozenProject || !frozenScript || projectGenerationSignature(project as unknown as Record<string, unknown>) !== projectGenerationSignature(frozenProject)
    || scriptRevision(current) !== scriptRevision(frozenScript)) return invalid();
  try { assertGenerationInputs(payload.snapshot?.referenceInputs); }
  catch (error) {
    if (error instanceof GenerationInputError) throw new KlingError(error.code, error.message, 409);
    throw error;
  }
}

/** An explicit confirmation restores observation of this same child, never creates a replacement. */
export function continueKlingBatchAuthorization(job: BatchJob, store: Pick<ReturnType<typeof getDb>, "select" | "update">): KlingJobData["batchAuthorization"] {
  if (!job.data.batchAuthorization) return undefined;
  assertKlingBatchAuthorization(job, store, true);
  const { item } = activeBatch(job, store, true);
  const checkpoint = item.checkpoint ? decryptGenerationValue<Record<string, unknown>>(item.checkpoint) : {};
  store.update(generationItems).set({ status: "queued", stage: "queued_submission", error: null, errorCode: null, nextRunAt: Date.now(),
    checkpoint: encryptGenerationValue({ ...checkpoint, childJobId: job.id, klingObserveOnly: true, stage: "queued_submission" }),
    result: { ...item.result, childJobId: job.id }, updatedAt: Date.now() }).where(eq(generationItems.id, item.id)).run();
  return { ...job.data.batchAuthorization, continuationEpoch: job.data.authorizationEpoch + 1 };
}

export function isKlingBatchQueueError(error: KlingJobData["error"]): boolean {
  return !error || ["KLING_PROFILE_BUSY", "KLING_REQUEST_CONFLICT"].includes(error.code);
}
