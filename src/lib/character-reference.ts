import type { Character } from "@/lib/stores/project-store";

export const MAX_CHARACTER_REFERENCE_IMAGES = 8;
export const MAX_CHARACTER_REFERENCE_BYTES = 20 * 1024 * 1024;
export const CHARACTER_REFERENCE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

type SheetCharacter = Pick<Character, "name" | "appearance" | "sourceReferenceImages">;

export function hasCharacterSheetInput(character: SheetCharacter): boolean {
  return Boolean(character.appearance?.trim() || character.sourceReferenceImages?.length);
}

/** Keep uploaded portraits separate from the generated sheet used by later shots. */
export function characterSheetRequest(character: SheetCharacter) {
  return {
    appearance: character.appearance ?? "",
    name: character.name,
    referenceImageUrls: character.sourceReferenceImages ?? [],
  };
}

/** A late generation result must not restore a sheet from replaced portraits. */
export function hasSameCharacterSheetInput(original: SheetCharacter, current?: SheetCharacter): boolean {
  return Boolean(current && JSON.stringify(characterSheetRequest(original)) === JSON.stringify(characterSheetRequest(current)));
}
