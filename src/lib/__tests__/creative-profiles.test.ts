import { describe, expect, it } from "vitest";
import { createCreativeProfileSnapshot, createTideweOutdoorProfile, resolveCreativeProfile, sanitizeCreativeProfile, sanitizeCreativeProfileDrafts, validateCreativeProfileInput, checkCreativeProfileContext } from "@/lib/creative-profiles";

describe("TIDEWE creative profiles", () => {
  it.each(["short_video_sales", "short_video_sales_v1", { creationType: "short_video_sales" }, { styleType: "pain_point" }, { creationType: "tidewe_outdoor", id: "short_video_sales_v1" }])("rejects removed or mixed profile identities: %j", value => {
    expect(validateCreativeProfileInput(value).error).toBeTruthy();
  });
  it("keeps all TIDEWE creation settings and frozen metadata", () => {
    const profile = createTideweOutdoorProfile({ targetDuration: 60, videoMode: "product_closeup", narrativeAngle: "gift", speechMode: "voiceover", composeSnapshot: { subtitles: false, quality: "hd" } });
    expect(validateCreativeProfileInput(profile)).toEqual({ profile });
    expect(createCreativeProfileSnapshot(profile, 3)).toEqual({ profile, creativeConfigRevision: 3 });
    expect(sanitizeCreativeProfile({ ...profile, corpusVersion: "historical", promptCompilerVersion: "older" })).toMatchObject({ corpusVersion: "historical", promptCompilerVersion: "older" });
  });
  it("keeps removed stored profiles archived without converting them to TIDEWE", () => {
    const old = { creationType: "short_video_sales", styleType: "scene", videoMode: "graphic_montage" };
    expect(sanitizeCreativeProfile(old)).toBeUndefined();
    expect(resolveCreativeProfile(old)).toMatchObject({ creationType: "unsupported", styleType: "scene", videoMode: "graphic_montage" });
    expect(resolveCreativeProfile(undefined)).toMatchObject({ creationType: "unsupported" });
    expect(sanitizeCreativeProfileDrafts({ short_video_sales: old, tidewe_outdoor: createTideweOutdoorProfile() })).toEqual({ tidewe_outdoor: createTideweOutdoorProfile() });
  });
  it("keeps frozen TIDEWE settings authoritative after configuration edits", () => {
    const frozen = createTideweOutdoorProfile({ speechMode: "voiceover" });
    const result = checkCreativeProfileContext({ creativeProfile: createTideweOutdoorProfile(), creativeConfigRevision: 4 }, { styleType: "tidewe_outdoor", creativeProfileSnapshot: createCreativeProfileSnapshot(frozen, 1) });
    expect(result).toMatchObject({ ok: true, projectProfile: frozen, scriptProfile: frozen, projectRevision: 4, scriptRevision: 1 });
    expect(checkCreativeProfileContext({ creativeProfile: createTideweOutdoorProfile() }, { styleType: "pain_point" }).ok).toBe(false);
    expect(checkCreativeProfileContext({}, { styleType: "scene" }).ok).toBe(true);
  });
});
