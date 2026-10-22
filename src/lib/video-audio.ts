export type VideoAudioMode = "ambient" | "silent" | "native" | "none";

/** Shared with the motion builder so audio is chosen once instead of overridden later. */
export const VIDEO_AUDIO_DIRECTIONS = {
  ambient: {
    zh: "音效：自然环境音与动作音效贴合画面，无人声说话，环境底噪保持同一空间的延续感",
    en: "sound: natural ambient and action sound effects matching the scene, no speech, the ambient noise floor stays continuous as one space",
  },
  silent: {
    zh: "声音要求：视频全程静音，不生成人声、旁白、对白、背景音乐、环境音或音效",
    en: "Audio: keep the entire video silent; do not generate speech, narration, dialogue, music, ambience, or sound effects",
  },
  native: {
    zh: "声音：保留与画面匹配的自然环境音与动作音效，有台词时保持人声清晰",
    en: "Audio: preserve natural ambience and action sounds matching the scene; keep any scripted dialogue clear",
  },
} as const;

export const LEGACY_SILENT_PROMPT_SUFFIX = "声音要求：不生成声音，视频全程保持静音，不生成人声、旁白、对白、背景音乐、环境音或音效。此静音要求覆盖前文所有声音、音频和音效描述。";

// These are exact phrases emitted by our previous builders, never a free-form audio paragraph.
const MANAGED_AUDIO_PHRASES = [
  LEGACY_SILENT_PROMPT_SUFFIX,
  ...Object.values(VIDEO_AUDIO_DIRECTIONS).flatMap((direction) => [direction.zh, direction.en]),
  "音效：自然环境音与动作音效贴合画面",
  "sound: natural ambient and action sound effects matching the scene",
  "无口播、无对白、不要生成配音，声音由后期旁白提供。No speech or dialogue; narration will be added separately.",
  "保留与画面匹配的环境声和音效，无口播、无对白；旁白将在后期叠加。Preserve matching ambience and sound effects. No speech or dialogue; narration will be mixed in later.",
].sort((a, b) => b.length - a.length);

/** Protect literal labels, subtitles, dialogue, and screen copy from audio-template cleanup. */
function quotedPositions(text: string): Uint8Array {
  const positions = new Uint8Array(text.length);
  const endings: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』", '"': '"', "'": "'" };
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const escaped = i > 0 && text[i - 1] === "\\";
    if (stack.length) {
      positions[i] = 1;
      if (!escaped && char === stack[stack.length - 1]) stack.pop();
      else if (!escaped && endings[char] && char !== '"' && char !== "'") stack.push(endings[char]);
    } else if (!escaped && endings[char]) {
      // An apostrophe inside an English word is punctuation, not a quoted label.
      if (char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "")) continue;
      positions[i] = 1;
      stack.push(endings[char]);
    }
  }
  return positions;
}

/** Remove only our known audio sentences outside quoted copy; leave manual prose intact. */
export function stripManagedVideoAudio(prompt: string): string {
  const quoted = quotedPositions(prompt);
  let result = "";
  for (let i = 0; i < prompt.length;) {
    const phrase = !quoted[i] ? MANAGED_AUDIO_PHRASES.find((value) => prompt.startsWith(value, i) &&
      !quoted.subarray(i, i + value.length).some(Boolean) &&
      // A shortened legacy sentence must end here, not consume the beginning of a custom sentence.
      (/[。.!?]$/.test(value) || i + value.length === prompt.length || /[。.!?\r\n]/.test(prompt[i + value.length]))) : undefined;
    if (!phrase) { result += prompt[i]; i++; continue; }
    i += phrase.length;
    // Consume this generated sentence's own punctuation and padding only.
    while (i < prompt.length && /[。.]/.test(prompt[i]) && !quoted[i]) i++;
    while (i < prompt.length && /[ \t]/.test(prompt[i])) i++;
  }
  return result.trim();
}

/** Normalize legacy drafts and mode toggles without accumulating contradictory instructions. */
export function withVideoAudioMode(prompt: string, mode: VideoAudioMode, language?: "zh" | "en"): string {
  const base = stripManagedVideoAudio(prompt);
  if (!base || mode === "none") return base;
  const lang = language ?? (/[\u3400-\u9fff]/.test(base) ? "zh" : "en");
  return `${base}\n\n${VIDEO_AUDIO_DIRECTIONS[mode][lang]}${lang === "zh" ? "。" : "."}`;
}
