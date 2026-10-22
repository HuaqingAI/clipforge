import { toEditVariant } from "@/lib/gen-params";

type CharacterReferenceModel =
  | { ok: true; modelId: string }
  | { ok: false; error: string; errorEn: string };

/**
 * Sheet generation promises to use every uploaded portrait. Only enable known
 * provider/model contracts that actually forward all those references; generic
 * image-generation mode metadata alone cannot establish that contract.
 */
export function resolveCharacterReferenceModel(
  provider: string,
  model: string,
  referenceImageCount: number,
): CharacterReferenceModel {
  if (referenceImageCount === 0) return { ok: true, modelId: model };

  if (provider === "openai") {
    if (model.startsWith("gpt-image-")) return { ok: true, modelId: model };
    if (model === "dall-e-2") {
      if (referenceImageCount === 1) return { ok: true, modelId: model };
      return {
        ok: false,
        error: `DALL·E 2 仅支持 1 张参考图，当前上传了 ${referenceImageCount} 张。请在设置中更换支持多张参考图的 GPT Image 或 Seedream 模型。`,
        errorEn: `DALL·E 2 supports only one reference image, but ${referenceImageCount} were provided. Choose a GPT Image or Seedream model that supports multiple references in settings.`,
      };
    }
  }

  if (provider === "fal-ai") {
    const editModel = toEditVariant(model);
    if ([
      "openai/gpt-image-2/image-to-image",
      "fal-ai/gpt-image-1.5/edit",
      "fal-ai/bytedance/seedream/v5/lite/edit",
    ].includes(editModel)) {
      return { ok: true, modelId: editModel };
    }
  }

  if (provider === "atlas-cloud" && [
    "openai/gpt-image-2",
    "openai/gpt-image-2/text-to-image",
    "openai/gpt-image-2/edit",
  ].includes(model)) {
    return { ok: true, modelId: "openai/gpt-image-2/edit" };
  }

  if (provider === "volcengine" && [
    "doubao-seedream-5-0-260128",
    "doubao-seedream-4-0-250828",
  ].includes(model)) {
    return { ok: true, modelId: model };
  }

  return {
    ok: false,
    error: `当前生图模型（${provider} / ${model}）尚未支持使用全部人物参考图定妆。请在设置中更换支持参考图的模型，如 GPT Image 或 Seedream 的图片编辑模型。`,
    errorEn: `The selected image model (${provider} / ${model}) does not support this character-reference workflow. In settings, choose a reference-capable model such as GPT Image or a Seedream image-edit model.`,
  };
}
