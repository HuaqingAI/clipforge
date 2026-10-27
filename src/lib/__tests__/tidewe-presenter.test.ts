import { describe, expect, it } from "vitest";
import { createTideweOutdoorProfile, sanitizeCreativeProfile, validateCreativeProfileInput } from "@/lib/creative-profiles";
import {
  isValidTidewePresenterInput,
  snapshotTidewePresenter,
  tidewePresenterAnchor,
  tidewePresenterForPrompt,
  tidewePresenterReference,
} from "@/lib/tidewe/presenter";

const presenter = () => ({ id: "hunter", name: "Outdoor creator", appearance: "An adult in a green cap", description: "Calm demonstrations", referenceImages: ["/api/files/hunter-sheet.png"], sourceReferenceImages: ["https://example.test/portrait.png"] });

describe("TIDEWE presenter snapshots and strict profile inputs", () => {
  it("freezes the selected library details and reference arrays independently of later library edits", () => {
    const library = presenter();
    const frozen = snapshotTidewePresenter(library)!;
    const profile = createTideweOutdoorProfile({ presenter: library });
    library.name = "Changed name"; library.appearance = "Changed appearance";
    library.referenceImages[0] = "/api/files/new-sheet.png";
    library.sourceReferenceImages.push("https://example.test/another.png");
    expect(frozen).toEqual(presenter());
    expect(profile.presenter).toEqual(frozen);
    expect(sanitizeCreativeProfile(profile)).toMatchObject({ presenter: frozen });
  });

  it.each([
    { referenceImages: ["/api/files/identity.png"], sourceReferenceImages: [] },
    { referenceImages: [], sourceReferenceImages: ["https://example.test/portrait.png"] },
    { referenceImages: ["data:image/png;base64,aGVsbG8="], sourceReferenceImages: [] },
  ])("accepts image-only identity without inventing physical traits or sending image bytes to the language model", (images) => {
    const input = { id: "portrait", name: "Portrait creator", ...images };
    expect(isValidTidewePresenterInput(input)).toBe(true);
    const snapshot = snapshotTidewePresenter(input)!;
    expect(snapshot.appearance).toBe("");
    expect(tidewePresenterForPrompt(snapshot)).toEqual({ id: input.id, name: input.name, appearance: "", hasReferenceImage: true });
    expect(tidewePresenterAnchor(snapshot)).toContain("外貌以所选主播参考图为准");
    expect(JSON.stringify(tidewePresenterForPrompt(snapshot))).not.toContain(images.referenceImages[0] ?? images.sourceReferenceImages[0]);
    expect(validateCreativeProfileInput({ creationType: "tidewe_outdoor", presenter: input })).toMatchObject({ profile: { presenter: { appearance: "", name: input.name } } });
  });

  it("accepts an appearance-only identity and prefers an identity sheet before falling back to an uploaded portrait", () => {
    const appearanceOnly = { ...presenter(), referenceImages: [], sourceReferenceImages: [] };
    expect(isValidTidewePresenterInput(appearanceOnly)).toBe(true);
    expect(tidewePresenterReference({ presenter: appearanceOnly })).toBeUndefined();
    expect(tidewePresenterForPrompt(snapshotTidewePresenter(appearanceOnly))).toMatchObject({ appearance: appearanceOnly.appearance, hasReferenceImage: false });
    expect(tidewePresenterReference({ presenter: presenter() })).toBe("/api/files/hunter-sheet.png");
    expect(tidewePresenterReference({ presenter: { ...presenter(), referenceImages: [] } })).toBe("https://example.test/portrait.png");
    expect(tidewePresenterReference({})).toBeUndefined();
  });

  it.each([
    { id: "" }, { name: " " }, { appearance: 3 }, { description: {} },
    { id: "x".repeat(129) }, { name: "x".repeat(121) },
    { appearance: "x".repeat(2401) }, { description: "x".repeat(601) },
    { referenceImages: "https://example.test/portrait.png" }, { sourceReferenceImages: {} },
    { referenceImages: [123] }, { sourceReferenceImages: [null] },
    { referenceImages: ["javascript:alert(1)"] }, { sourceReferenceImages: ["file:///E:/portrait.png"] },
    { referenceImages: ["/api/files/../secret.png"] }, { referenceImages: ["/api/files/%2e%2e/secret.png"] },
    { referenceImages: ["https://user:pass@example.test/portrait.png"] },
    { referenceImages: Array.from({ length: 9 }, (_, index) => `https://example.test/${index}.png`) },
    { sourceReferenceImages: Array.from({ length: 9 }, (_, index) => `/api/files/${index}.png`) },
    { appearance: "", referenceImages: [], sourceReferenceImages: [] },
  ])("rejects invalid or lossy new profile presenter inputs: %j", (patch) => {
    const input = { ...presenter(), ...patch };
    expect(isValidTidewePresenterInput(input)).toBe(false);
    expect(validateCreativeProfileInput({ creationType: "tidewe_outdoor", presenter: input })).toMatchObject({ error: expect.any(String) });
  });

  it("keeps tolerant snapshot reads bounded while strict writes reject data that would lose identity details", () => {
    const input = { ...presenter(), name: "n".repeat(140), referenceImages: ["javascript:alert(1)", ...Array.from({ length: 10 }, (_, index) => `https://example.test/${index}.png`)] };
    const snapshot = snapshotTidewePresenter(input)!;
    expect(snapshot.name).toHaveLength(120);
    expect(snapshot.referenceImages).toHaveLength(8);
    expect(snapshot.referenceImages).not.toContain("javascript:alert(1)");
    expect(isValidTidewePresenterInput(input)).toBe(false);
    expect(snapshotTidewePresenter({ id: "hunter", name: "Hunter", referenceImages: [] })).toBeUndefined();
  });
});
