/** Ignore navigation/status timestamps while comparing the inputs a generation actually consumed. */
export function projectGenerationSignature(project: Record<string, unknown>): string {
  return JSON.stringify([
    project.id, project.contentType, project.topic, project.productName, project.productCategory,
    project.productDescription, project.productAnalysis, project.productFacts, project.productImages,
    project.videoMode, project.creativeProfile, project.creativeConfigRevision, project.characterId,
    project.creativeIntent, project.visualBible,
  ]);
}
