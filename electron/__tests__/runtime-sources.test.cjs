const { test } = require("node:test");
const assert = require("node:assert/strict");
const { domesticMirrorUrls, withDomesticMirrors, resourceDownloadUrls, validateResourceMirrors } = require("../runtime-sources.cjs");

const alignment = { url: "https://huggingface.co/facebook/wav2vec2-base-960h/resolve/22aad52d435eb6dbaf354bdad9b0da84ce7d6156/model.safetensors" };
const whisper = { url: "https://huggingface.co/onnx-community/whisper-tiny_timestamped/resolve/517244293732ee2d58139af5814231b7e6830a0d/onnx/decoder_model_merged_q4.onnx" };

test("reviewed mirror candidates preserve upstream identity and limit acceleration to requested resources", () => {
  const dependency = { id: "numpy", url: "https://files.pythonhosted.org/packages/12/34/pinned/numpy-2.5.4-cp312-cp312-win_amd64.whl", size: 123, sha256: "a".repeat(64) };
  const mirrored = withDomesticMirrors(dependency);
  assert.deepEqual(mirrored, { ...dependency, mirrors: [
    "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/packages/12/34/pinned/numpy-2.5.4-cp312-cp312-win_amd64.whl",
    "https://mirrors.aliyun.com/pypi/packages/12/34/pinned/numpy-2.5.4-cp312-cp312-win_amd64.whl",
  ] });
  assert.equal(dependency.mirrors, undefined);
  assert.deepEqual(resourceDownloadUrls(mirrored), [...mirrored.mirrors, dependency.url]);
  assert.deepEqual(domesticMirrorUrls({ url: "https://download-r2.pytorch.org/whl/cpu/torch-2.8.0%2Bcpu-cp312-cp312-win_amd64.whl" }), [
    "https://mirrors.nju.edu.cn/pytorch/whl/cpu/torch-2.8.0%2Bcpu-cp312-cp312-win_amd64.whl",
    "https://mirrors.aliyun.com/pytorch-wheels/cpu/torch-2.8.0%2Bcpu-cp312-cp312-win_amd64.whl",
  ]);
  for (const url of ["https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip", "https://registry.npmjs.org/onnxruntime-web/-/locked.tgz", "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"]) {
    assert.deepEqual(resourceDownloadUrls(withDomesticMirrors({ url })), [url]);
  }
});

test("ModelScope mirrors use exact repositories and their own fixed commits", () => {
  assert.deepEqual(domesticMirrorUrls(alignment), ["https://modelscope.cn/models/AI-ModelScope/wav2vec2-base-960h/resolve/0c5dbe4bd2fc93cfaf7caf14bba8758bc433ae2b/model.safetensors"]);
  assert.deepEqual(domesticMirrorUrls(whisper), ["https://modelscope.cn/models/onnx-community/whisper-tiny_timestamped/resolve/57245b55a20850977898baf6d5cdcc24d98a44e5/onnx/decoder_model_merged_q4.onnx"]);
  for (const source of [alignment, whisper]) {
    const mirrored = withDomesticMirrors(source);
    assert.doesNotThrow(() => validateResourceMirrors(mirrored));
    for (const mirror of [mirrored.mirrors[0].replace(/resolve\/[a-f0-9]+\//, "resolve/main/"), mirrored.mirrors[0].replace("/models/", "/models/unreviewed/"), mirrored.mirrors[0].replace(/[^/]+$/, "different.onnx")]) {
      assert.throws(() => validateResourceMirrors({ ...source, mirrors: [mirror] }), /已审核/);
    }
    assert.deepEqual(domesticMirrorUrls({ url: source.url.replace(/resolve\/[a-f0-9]+\//, "resolve/main/") }), []);
  }
});

test("a reviewed hostname cannot authorize another wheel, credentials, HTTP or duplicate mirror entries", () => {
  const resource = withDomesticMirrors({ url: "https://files.pythonhosted.org/packages/ab/cd/locked/pip-25.0.1-py3-none-any.whl" });
  assert.doesNotThrow(() => validateResourceMirrors(resource));
  for (const mirrors of [
    [resource.mirrors[0].replace("25.0.1", "99.0")],
    [resource.mirrors[0].replace("https://", "https://user:password@")],
    [resource.mirrors[0].replace("https://", "http://")],
    [resource.mirrors[0] + "#unreviewed"],
    [resource.mirrors[0], resource.mirrors[0]],
    ["https://example.com/pip.whl"],
    [resource.url],
  ]) assert.throws(() => validateResourceMirrors({ ...resource, mirrors }), /镜像/);
  assert.throws(() => validateResourceMirrors({ ...resource, mirrors: "https://example.com" }), /镜像列表/);
  assert.throws(() => validateResourceMirrors({ ...resource, mirrors: [null] }), /镜像地址/);
});

test("HTTP mirror fixtures require an explicit test opt-in and stay on loopback", () => {
  const resource = { url: "http://127.0.0.1:1234/upstream", mirrors: ["http://127.0.0.1:1234/mirror"] };
  assert.throws(() => validateResourceMirrors(resource), /HTTPS/);
  assert.doesNotThrow(() => validateResourceMirrors(resource, { allowHttpForTests: true }));
  assert.throws(() => validateResourceMirrors({ ...resource, mirrors: ["http://example.com/file"] }, { allowHttpForTests: true }), /HTTPS/);
});
