import type { NamespaceMessages } from "../config";

// newProject 命名空间词条（zh 为原文，en 为翻译）
export const newProject: NamespaceMessages = {
  zh: {
    // 进度提示
    progressCreating: "正在创建项目...",
    progressUploading: "正在上传商品图片...",
    // 错误提示
    errorCreateFailed: "项目创建失败，请重试",
    errorUploadFailed: "图片上传失败，请检查网络后重试",
    errorGeneric: "操作失败，请重试",
    // 页面标题
    pageTitlePrefix: "新建",
    // LLM 未配置警告
    llmWarnTitle: "请先配置 LLM 服务",
    llmWarnDesc: "脚本生成需要 LLM（如 GPT-4o），请先在设置中配置 API Key。",
    llmWarnCta: "前往设置 →",
    // 上传区
    stepUploadTitle: "上传商品图片",
    imageCount: "{n}/5 张",
    dropHintPrefix: "拖拽图片到这里，或 ",
    dropHintClick: "点击上传",
    dropHintFormats: "支持 JPG / PNG / WebP，最多 5 张",
    imageAlt: "商品图片",
    removeImage: "删除商品图片",
    // 商品信息表单
    stepInfoTitle: "填写商品信息",
    productNameLabel: "商品名称",
    // 视频配置
    stepConfigTitle: "选择视频配置",
    durationLabel: "目标时长",
    videoModeLabel: "视频模式",
    creationTypeLabel: "创作类型",
    // 提交
    submitProcessing: "处理中...",
    hintNeedLlm: "请先在设置中配置 LLM API Key",
    hintNeedInput: "请上传至少一张商品图并填写商品名称",
  },
  en: {
    // 进度提示
    progressCreating: "Creating project...",
    progressUploading: "Uploading product images...",
    // 错误提示
    errorCreateFailed: "Failed to create project. Please try again.",
    errorUploadFailed: "Image upload failed. Check your connection and retry.",
    errorGeneric: "Something went wrong. Please try again.",
    // 页面标题
    pageTitlePrefix: "New ",
    // LLM 未配置警告
    llmWarnTitle: "Set up your LLM service first",
    llmWarnDesc: "Script generation needs an LLM (such as GPT-4o). Add your API key in Settings first.",
    llmWarnCta: "Go to Settings →",
    // 上传区
    stepUploadTitle: "Upload product images",
    imageCount: "{n}/5",
    dropHintPrefix: "Drag images here, or ",
    dropHintClick: "click to upload",
    dropHintFormats: "JPG / PNG / WebP supported, up to 5",
    imageAlt: "Product image",
    removeImage: "Remove product image",
    // 商品信息表单
    stepInfoTitle: "Enter product details",
    productNameLabel: "Product name",
    // 视频配置
    stepConfigTitle: "Choose video settings",
    durationLabel: "Target length",
    videoModeLabel: "Video mode",
    creationTypeLabel: "Creation type",
    // 提交
    submitProcessing: "Processing...",
    hintNeedLlm: "Add your LLM API key in Settings first",
    hintNeedInput: "Upload at least one product image and enter a product name",
  },
};
