export const TIDEWE_COPY_INPUT_MAX_LENGTH = 12000;
export type TideweCopySource = "ai" | "manual";

/** Lightweight form feedback; the server validates the submitted original again. */
export function tideweCopyInputError(text: string): "copyInputRequired" | "copyInputTooLong" | "copyInputEnglish" | undefined {
  if (text.trim().length < 2) return "copyInputRequired";
  if (text.length > TIDEWE_COPY_INPUT_MAX_LENGTH) return "copyInputTooLong";
  if (!/[A-Za-z]/.test(text) || /[\u3400-\u9fff]/u.test(text)) return "copyInputEnglish";
}
