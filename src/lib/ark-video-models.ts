/** Ark serves every video mode through the same model ID, without Atlas-style mode suffixes. */
export function arkSeedanceVersion(modelId: string): "2.0" | "2.5" | undefined {
  const id = modelId.toLowerCase();
  if (/^doubao-seedance-2(?:\.5|-5(?:-\d{6})?)$/.test(id)) return "2.5";
  if (/^doubao-seedance-2(?:\.0(?:-fast|-mini)?|-0(?:-pro|-fast|-mini)?(?:-\d{6})?)$/.test(id)) return "2.0";
  return undefined;
}
