/** Shared by the browser preview and the server submission boundary. */
export const VIDEO_PROMPT_VERSION = 2;
export const VIDEO_PROMPT_MAX_LENGTH = 12_000;

export interface VideoPromptIssue { code: string; message: string; }

/** Mask display copy before inspecting instructions. ASCII apostrophes are ordinary text. */
function inspectQuotes(value: string): { masked: string; quoted: boolean[]; balanced: boolean } {
  const stack: string[] = [];
  const quoted: boolean[] = [];
  let balanced = true;
  let masked = "";
  const pairs: Record<string, string> = { "“": "”", "‘": "’", "「": "」", "『": "』", '"': '"' };
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const escaped = char === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(value.slice(0, index));
    const apostrophe = char === "’" && /[A-Za-z0-9]/.test(value[index - 1] ?? "") && /[A-Za-z0-9]/.test(value[index + 1] ?? "");
    const inside = stack.length > 0;
    let delimiter = false;
    if (!escaped && !apostrophe && char === stack.at(-1)) { stack.pop(); delimiter = true; }
    else if (!escaped && pairs[char]) { stack.push(pairs[char]); delimiter = true; }
    else if (!apostrophe && ["”", "’", "」", "』"].includes(char) && !inside) { balanced = false; delimiter = true; }
    quoted[index] = inside || delimiter;
    masked += quoted[index] ? " " : char;
  }
  return { masked, quoted, balanced: balanced && stack.length === 0 };
}

/** Only normalize section boundaries; an explicit separator keeps paragraphs intact. Quoted copy is never rewritten. */
export function joinVideoPromptParts(parts: readonly string[], lang: "zh" | "en", separator?: string): string {
  const normalized = parts.map((part) => {
    const value = part.trim();
    const { quoted } = inspectQuotes(value);
    let start = 0;
    let end = value.length;
    while (start < end && !quoted[start] && /[\s。.!！?？;；,，]/.test(value[start])) start++;
    while (end > start && !quoted[end - 1] && /[\s。.!！?？;；,，]/.test(value[end - 1])) end--;
    return value.slice(start, end);
  }).filter(Boolean);
  if (!normalized.length) return "";
  const punctuation = lang === "zh" ? "。" : ".";
  return normalized.map((part) => `${part}${punctuation}`).join(separator ?? (lang === "zh" ? "" : " "));
}

// These checks deliberately cover explicit, common contradictions, not general language inference.
const NEGATED = /(?:不要|不应|不得|禁止|避免|不能|不会|不再|不做|不进行|不允许|不生成|不出现|不添加|无需|没有|无须|不(?:移动|转动|旋转|演示|静止|固定|横移|平移|推进|推近|拉远|环绕|播放|保留|使用|产生)|无(?:声音|音频|音乐|音效|环境音|人声|旁白|对白|运镜|移动)|\b(?:no|not|never|without|avoid|don't|do not)\b)/i;
const SEQUENCE = /(?:先.{0,80}(?:再|后|然后)|随后|接着|之后|最后|\b(?:then|afterwards|subsequently|followed by)\b)/i;
const AUDIO_LIST_ITEM = /^(?:(?:and|or)\s+)?(?:speech|narration|dialogue|music|ambience|ambient (?:sounds?|noise)|sound effects?|voiceover|background music|人声|旁白|对白|背景音乐|环境音|音效)$/i;

function instructionClauses(masked: string): { clauses: string[]; positive: string[] } {
  const clauses: string[] = [];
  const positive: string[] = [];
  for (const sentence of masked.split(/[。.!！？?;；\n]/)) {
    let negativeList = false;
    for (const fragment of sentence.split(/[,，]/)) {
      const clause = fragment.trim();
      if (!clause) continue;
      clauses.push(clause);
      const negated: boolean = NEGATED.test(clause) || (negativeList && AUDIO_LIST_ITEM.test(clause));
      if (!negated) positive.push(clause);
      negativeList = negated;
    }
  }
  return { clauses, positive };
}

export function validateVideoPrompt(prompt: string): VideoPromptIssue[] {
  const issues: VideoPromptIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  if (!prompt.trim()) add("empty", "提示词不能为空。");
  if (prompt.length > VIDEO_PROMPT_MAX_LENGTH) add("too_long", `提示词超过 ${VIDEO_PROMPT_MAX_LENGTH} 字符，请按完整句子精简后再提交。`);
  if (prompt.includes("\0")) add("nul", "提示词包含无效的空字符，请删除后再提交。");
  if (prompt.trimStart().startsWith("--")) add("invalid_start", "提示词不能以 -- 开头。");
  const { masked, balanced } = inspectQuotes(prompt);
  if (!balanced) add("unclosed_quote", "提示词中的引号未闭合，请补全展示文字和引号后再提交。");
  // Split commas as well so a negative instruction cannot hide a positive one in another clause.
  const { clauses, positive } = instructionClauses(masked);
  const has = (pattern: RegExp) => positive.some((clause) => pattern.test(clause));
  const sequenced = SEQUENCE.test(masked.replace(/\n/g, " "));
  const fixedCamera = has(/(?:固定(?:镜头|机位|相机)|(?:镜头|相机|机位)(?:全程)?(?:固定|保持静止)|\b(?:static|fixed|locked[- ]off|stationary)\s+(?:camera|shot)\b|\bcamera\s*(?::\s*|(?:remains?\s+)?)(?:fixed|static|stationary|locked(?:[- ]off)?)\b)/i);
  const movingCamera = has(/(?:(?:镜头|相机|机位)[^。]{0,16}(?:横移|平移|推进|推近|拉远|环绕|移动|摇摄|升降|手持晃动)|(?:大幅|明显|大胆)[^。]{0,6}运镜|运镜幅度[^。]{0,8}(?:大胆|明显|大幅)|\b(?:dolly|pan|orbit|tracking|crane|zoom)\s+(?:camera|shot|left|right|in|out|forward|backward)\b|\bcamera\s+(?:(?:slowly|smoothly|gently|rapidly)\s+)?(?:moves?|pans?|pushes|orbits?|tracks?|zooms?)\b|\b(?:bold|pronounced|large)[^.]{0,20}\bcamera movement\b)/i);
  if (fixedCamera && movingCamera && !sequenced) add("camera_conflict", "同时要求固定镜头和移动镜头，请明确运镜方式或先后顺序。");
  const stillSubject = has(/(?:(?:商品|产品|主体|机身)[^。]{0,18}(?:保持静止|全程静止|始终静止|静止不动)|(?:商品|产品|主体|机身)静止|\b(?:product|subject)\b[^.]{0,25}\b(?:stationary|motionless|still(?!\s+(?:rotat|mov|spin|turn)))\b)/i);
  const movingSubject = has(/(?:(?:转动|旋转|翻转)(?:商品|产品|主体|机身)|(?:商品|产品|主体|机身)[^。]{0,8}(?:旋转|转动|翻转)|手部演示|\b(?:rotate|turn|spin|flip)\s+(?:the\s+)?(?:product|device|subject)|\b(?:product|subject)\s+(?:rotates?|spins?|turns?)\b|\bhand(?:s)?[- ]on demonstration\b)/i);
  if (stillSubject && movingSubject && !sequenced) add("subject_conflict", "同时要求商品静止和转动或手部演示，请明确主体动作或先后顺序。");
  const plainBackground = has(/(?:背景[^。]{0,10}(?:纯色|纯净[^。]{0,6}色|纯[^。]{0,3}色)|(?:纯色|纯净[^。]{0,6}色)[^。]{0,6}背景|\b(?:plain|solid[- ]colou?r|clean solid)[^.]{0,15}\bbackground\b)/i);
  const addedBackground = has(/(?:背景(?:中|里)?[^。]{0,8}(?:一盏灯|一群人|人物|人群|灯的光斑|出现[^。]{0,8}(?:灯|人|家具)|新增[^。]{0,8}(?:灯|人|家具))|\bbackground\b[^.]{0,20}\b(?:lamp|people|crowd|furniture)\b|\b(?:lamp|people|crowd|furniture)\b[^.]{0,15}\bbackground\b)/i);
  if (plainBackground && addedBackground) add("background_conflict", "纯色背景同时出现背景灯、人物或家具，请明确背景内容。");
  // Silence is a negative audio instruction, so inspect all clauses for it separately.
  const silent = clauses.some((clause) => /(?:全程(?:保持)?静音|视频(?:保持)?静音|(?:不生成|不要生成)(?:任何)?(?:声音|音频)|\b(?:silent|muted|no audio|no sound)\b)/i.test(clause));
  const sound = has(/(?:自然环境音|环境底噪|环境音[^。]{0,10}(?:延续|保持|贴合)|(?:生成|添加|播放|保留)[^。]{0,10}(?:环境音|音效|音乐|人声|旁白|对白)|(?:音效|声音|音频)\s*[:：]\s*[^。]+|\b(?:ambient (?:sounds?|audio|noise)|sound effects?|background music|voiceover)\b)/i);
  if (silent && sound) add("audio_conflict", "同时要求静音和生成声音，请统一声音要求。");
  return issues;
}
