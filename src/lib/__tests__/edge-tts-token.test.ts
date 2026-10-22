import { afterEach, describe, expect, it, vi } from "vitest";
import { EDGE_TTS_DEFAULT_VERSION, generateSecMsGec } from "@/lib/edge-tts-token";

// Expected values come from edge-tts' Python generate_sec_ms_gec_v2, not from
// the TypeScript implementation: rany2/edge-tts@b2ffbdd9f43f28f03cc939b5de0f3964aa62d60e.
const JAN_2024_TOKEN =
  "9586E5FBB4BD2CFF-DE636BA8369C7431ED826BDEEB00ECA1CC52826A6BB736DCB150A2AF37DFC498";

afterEach(() => vi.useRealTimers());

describe("Edge TTS v2 request token", () => {
  it.each([
    [0, "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"],
    [1_704_067_200_000, JAN_2024_TOKEN],
    [1_792_373_700_000, "92DA679FD0563798-169618B26E947C9C3FDE1A5C466F91BBEC90B06B3E6ED333C89EC423362C8773"],
    [2_000_000_000_000, "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E"],
  ])("matches the independent Python reference at timestamp %i ms", (timestampMs, token) => {
    expect(generateSecMsGec(timestampMs)).toBe(token);
  });

  it("uses the same five-minute UTC bucket through its final millisecond", () => {
    expect(generateSecMsGec(1_704_067_499_999)).toBe(JAN_2024_TOKEN);
    expect(generateSecMsGec(1_704_067_500_000)).toBe(
      "39722CF1D9AF74D9-7422F43711D3DB14B0A1CF59EF2B66CC8B23D7E2EEB334AF30D40CC81BDB5139",
    );
    expect(generateSecMsGec(1_704_067_199_999)).toBe(
      "6A5BCF0F468A2E94-33EDC9C9CDD49B215617BD588A0E331CFA6BA9BCF15E17CF6494C185B68D34AA",
    );
  });

  it("produces the same token for the same instant written in different time zones", () => {
    for (const date of [
      "2024-01-01T00:00:00Z",
      "2024-01-01T08:00:00+08:00",
      "2023-12-31T16:00:00-08:00",
    ]) {
      expect(generateSecMsGec(Date.parse(date))).toBe(JAN_2024_TOKEN);
    }
  });

  it("uses the current time when no timestamp is supplied", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:02:03Z"));
    expect(generateSecMsGec()).toBe(JAN_2024_TOKEN);
  });

  it("advertises the v2 protocol expected by the generated token", () => {
    expect(EDGE_TTS_DEFAULT_VERSION).toBe("2-143.0.3650.75");
  });
});
