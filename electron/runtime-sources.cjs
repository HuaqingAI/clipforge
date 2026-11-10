// Reviewed mirrors serve the same pinned upstream bytes. Keep the upstream URL
// and its checksum in the manifest so a mirror never defines a new artifact.
const MODEL_MIRRORS = [
  {
    upstream: "/facebook/wav2vec2-base-960h/resolve/22aad52d435eb6dbaf354bdad9b0da84ce7d6156/",
    mirror: "https://modelscope.cn/models/AI-ModelScope/wav2vec2-base-960h/resolve/0c5dbe4bd2fc93cfaf7caf14bba8758bc433ae2b/",
  },
  {
    upstream: "/onnx-community/whisper-tiny_timestamped/resolve/517244293732ee2d58139af5814231b7e6830a0d/",
    mirror: "https://modelscope.cn/models/onnx-community/whisper-tiny_timestamped/resolve/57245b55a20850977898baf6d5cdcc24d98a44e5/",
  },
];

function domesticMirrorUrls(resource) {
  const url = new URL(resource.url);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return [];
  if (url.hostname === "files.pythonhosted.org" && url.pathname.startsWith("/packages/")) {
    const file = url.pathname.slice("/packages/".length);
    return [`https://mirrors.tuna.tsinghua.edu.cn/pypi/web/packages/${file}`, `https://mirrors.aliyun.com/pypi/packages/${file}`];
  }
  if (["download.pytorch.org", "download-r2.pytorch.org"].includes(url.hostname) && url.pathname.startsWith("/whl/cpu/")) {
    const file = url.pathname.slice("/whl/cpu/".length);
    return [`https://mirrors.nju.edu.cn/pytorch/whl/cpu/${file}`, `https://mirrors.aliyun.com/pytorch-wheels/cpu/${file}`];
  }
  if (url.hostname === "huggingface.co") {
    const model = MODEL_MIRRORS.find(model => url.pathname.startsWith(model.upstream));
    if (model) return [model.mirror + url.pathname.slice(model.upstream.length)];
  }
  return [];
}

function withDomesticMirrors(resource) {
  const mirrors = domesticMirrorUrls(resource);
  return mirrors.length ? { ...resource, mirrors } : { ...resource };
}

function resourceDownloadUrls(resource) {
  if (resource.mirrors !== undefined && !Array.isArray(resource.mirrors)) throw new Error("运行资源镜像列表无效");
  return [...(resource.mirrors || []), resource.url];
}

function localTestUrl(url) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function validateResourceMirrors(resource, { allowHttpForTests = false } = {}) {
  const urls = resourceDownloadUrls(resource);
  if (urls.length > 3 || new Set(urls).size !== urls.length) throw new Error("运行资源镜像列表重复或超出限制");
  const approved = domesticMirrorUrls(resource);
  for (const value of urls.slice(0, -1)) {
    if (typeof value !== "string") throw new Error("运行资源镜像地址无效");
    const url = new URL(value);
    if (url.username || url.password || url.hash || !(url.protocol === "https:" || allowHttpForTests && localTestUrl(url))) throw new Error("运行资源镜像必须使用 HTTPS 下载地址");
    if (!(allowHttpForTests && localTestUrl(url)) && !approved.includes(value)) throw new Error(`运行资源镜像不在已审核的固定来源中：${url.hostname}`);
  }
}

module.exports = { domesticMirrorUrls, withDomesticMirrors, resourceDownloadUrls, validateResourceMirrors };
