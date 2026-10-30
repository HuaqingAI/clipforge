/** Pure capability data shared by browser controls and server adapters. */
export const OPENAI_FOCUS_MASK_MODELS: readonly string[] = [
  "gpt-image-2",
  "gpt-image-2-2026-04-21",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-flare-2026-09-08",
];

/** Older edit models remain accepted by the adapter without exposing them for focus repair. */
export const OPENAI_MASK_IMAGE_MODELS: readonly string[] = [
  ...OPENAI_FOCUS_MASK_MODELS,
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "chatgpt-image-latest",
];
