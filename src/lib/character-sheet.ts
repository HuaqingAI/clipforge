/**
 * Character sheet — multi-view reference generation for the presenter library.
 *
 * Why: a presenter described only in words drifts between generations (new face
 * every batch). One 2x2 turnaround sheet (front / side / back / close-up) rendered
 * in a single generation pins the SAME person from four angles; downstream passes
 * (storyboard grid, one-tap film, per-shot keyframes) attach the sheet as a
 * reference image, so the character stops morphing across shots and across videos.
 *
 * Pure prompt builder only; the route does the I/O.
 */
import { realFaceLine } from "@/lib/presenters";

const CJK_RE = /[一-鿿]/;

/**
 * Build the 2x2 multi-view sheet prompt. Language follows the appearance text
 * (CJK → Chinese). Hard constraints mirror the storyboard grid's: equal cells,
 * no text/borders (the sheet travels as a reference image), one identical person.
 */
export function buildCharacterSheetPrompt(appearance: string, name?: string, referenceImageCount = 0): string {
  const zh = CJK_RE.test(appearance);
  const who = (name ?? "").trim();
  if (referenceImageCount > 0) {
    if (zh) {
      return [
        `一张 2x2 等分四视图人物定妆参考图，整图 1:1 正方形，格与格之间只留极细的白色分隔缝。`,
        `输入的全部 ${referenceImageCount} 张人物参考图都属于同一个人。请联合所有参考图的不同角度识别人物身份，不能只使用第一张，也不要把参考图当作不同人物或混合出新面孔。`,
        `以参考图为身份依据，忠实保留本人五官、脸型、年龄感、发型发色、身形和服装，以及真实皮肤特征；不美化、不换脸、不改变其身份。参考图身份优先于文字，文字仅作补充，冲突时以参考图为准。`,
        ...(appearance.trim() ? [`人物补充描述${who ? `（${who}）` : ""}：${appearance}。`] : []),
        `四格是该人物在同一时刻的四个机位——同一张脸、同一发型、同一身衣服、同一站姿气质，浅灰纯色摄影棚背景，保留参考图中的真实人体比例。`,
        `四格内容：左上=正面全身；右上=左侧面全身；左下=背面全身；右下=正面肩部以上特写（清晰展示五官）。`,
        `硬性要求：严格等分四格；画面里不出现任何文字、编号、水印或边框装饰；四格人物必须完全是参考图里的同一个人。`,
      ].join("\n");
    }
    return [
      `A 2x2 four-view character reference sheet, square 1:1 overall, cells separated only by hairline white gutters.`,
      `All ${referenceImageCount} input reference images show the SAME person. Jointly study every reference and its different angles to identify that person; do not use only the first image, treat them as different people, or blend them into a new face.`,
      `Use the reference images as the identity source. Faithfully preserve the person's facial features, face shape, apparent age, hairstyle and hair color, build, clothing and real skin details; do not beautify, replace the face, or change identity. Reference identity takes priority over text; the text is supplementary, and references prevail in any conflict.`,
      ...(appearance.trim() ? [`Supplementary character description${who ? ` (${who})` : ""}: ${appearance}.`] : []),
      `All four cells are the SAME referenced person captured at the same moment from four angles — identical face, hair, outfit and posture, on a plain light-gray studio background, retaining the real body proportions shown in the references.`,
      `Cells: top-left = front full body; top-right = left-side full body; bottom-left = back full body; bottom-right = front shoulders-up close-up (features clearly visible).`,
      `Hard rules: strictly equal cells; no text, numbers, watermarks or decorative borders anywhere; the person must be exactly the same referenced person in all four cells.`,
    ].join("\n");
  }
  if (zh) {
    return [
      `一张 2x2 等分四视图人物定妆参考图，整图 1:1 正方形，格与格之间只留极细的白色分隔缝。`,
      `四格是同一个人物在同一时刻的四个机位——同一张脸、同一发型、同一身衣服、同一站姿气质，浅灰纯色摄影棚背景。`,
      `人物设定${who ? `（${who}）` : ""}：${appearance}。写实人体比例，头身比约 1:7~7.5，不做漫画式九头身拉长。`,
      `四格内容：左上=正面全身；右上=左侧面全身；左下=背面全身；右下=正面肩部以上特写（清晰展示五官）。`,
      realFaceLine(appearance) + "。",
      `硬性要求：严格等分四格；画面里不出现任何文字、编号、水印或边框装饰；四格人物必须完全是同一个人。`,
    ].join("\n");
  }
  return [
    `A 2x2 four-view character reference sheet, square 1:1 overall, cells separated only by hairline white gutters.`,
    `All four cells are the SAME person captured at the same moment from four angles — identical face, hair, outfit and posture, on a plain light-gray studio background.`,
    `Character${who ? ` (${who})` : ""}: ${appearance}. Realistic human proportions, head-to-body ratio about 1:7-7.5, never stylized elongated hero proportions.`,
    `Cells: top-left = front full body; top-right = left-side full body; bottom-left = back full body; bottom-right = front shoulders-up close-up (features clearly visible).`,
    realFaceLine(appearance) + ".",
    `Hard rules: strictly equal cells; no text, numbers, watermarks or decorative borders anywhere; the person must be exactly identical in all four cells.`,
  ].join("\n");
}
