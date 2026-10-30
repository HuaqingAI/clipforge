// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Shot } from "@/lib/db/schema";
import { createTideweOutdoorProfile } from "@/lib/creative-profiles";
import { buildStoryboardGridPrompt } from "@/lib/storyboard-grid";
import { buildStoryboardFilmPrompt } from "@/lib/storyboard-film";
import { TIDEWE_IMAGE_CAPTURE_POLICY } from "@/lib/tidewe/visual-policy";

const shots: Shot[] = [
  {
    shotId: 1, type: "hook", duration: 4, voiceover: "Look at the whole setup.",
    description: "主播在椅旁看向拍摄同伴，手扶靠背上沿。", camera: "全身与整椅同框",
    visualIntent: "交代真实使用空间", prompt: "林缘自然光下的全身构图",
    visualSource: "ai_generate", transition: "direct_concat",
    tidewe: { copySpan: { start: 0, end: 24 }, translation: "看看整套布置。", shotGoal: "人与椅子的空间关系", productVisible: true, personVisible: true, speechDelivery: "on_camera", factRefs: [], sceneId: "woods" },
  },
  {
    shotId: 2, type: "demo", duration: 4, voiceover: "Then check the feet.",
    description: "椅脚压住地面落叶，完整显示接地位置。", camera: "地面低机位近景",
    visualIntent: "观察接地结构", prompt: "低机位观察椅脚与落叶",
    visualSource: "ai_generate", transition: "direct_concat",
    tidewe: { copySpan: { start: 25, end: 45 }, translation: "再看看椅脚。", shotGoal: "椅脚与地面接触", productVisible: true, personVisible: false, speechDelivery: "off_camera", factRefs: [], sceneId: "woods" },
  },
];

describe("TIDEWE mixed framing across storyboard outputs", () => {
  it("keeps the approved per-cell composition and shared photography without adding dialogue to stills", () => {
    const before = structuredClone(shots);
    const grid = buildStoryboardGridPrompt(shots, null, { creativeProfile: createTideweOutdoorProfile(), aspectRatio: "16:9", productImageCount: 2 });
    expect(grid.split(TIDEWE_IMAGE_CAPTURE_POLICY)).toHaveLength(2);
    expect(grid).toContain("整图与每格画幅均为 16:9");
    expect(grid).toContain("第 1 格（第 1 行第 1 列）");
    expect(grid).toContain("第 2 格（第 1 行第 2 列）");
    expect(grid).toContain("第 9 格为占位");
    const detailCell = grid.split("第 2 格（")[1].split("第 3 格")[0];
    expect(detailCell).toContain(shots[1].camera);
    expect(detailCell).toContain(shots[1].description);
    expect(detailCell).toContain("无人出镜，不加入人脸、路人或手");
    expect(detailCell).not.toContain("嘴部清晰可见");
    for (const shot of shots) expect(grid).not.toContain(shot.voiceover);
    expect(shots).toEqual(before);
  });

  it("keeps exact speech once per film segment and does not turn narrated details into a talking head", () => {
    const film = buildStoryboardFilmPrompt(shots, null, { creativeProfile: createTideweOutdoorProfile() });
    expect(film).not.toContain("每段文案由画面中嘴部清晰可见");
    expect(film).toContain("[0-4秒] 镜头1");
    const detailSegment = film.split("[4-8秒] 镜头2")[1];
    expect(detailSegment).toContain("off-camera narration");
    expect(detailSegment).toContain("本镜为无人出镜");
    expect(detailSegment).not.toContain("must speak the following");
    for (const shot of shots) expect(film.split(shot.voiceover)).toHaveLength(2);
  });
});
