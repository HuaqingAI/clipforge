// Maintainer-only lock refresh. Installers never resolve indexes or run npm/pip online.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

const { withDomesticMirrors } = createRequire(import.meta.url)("../../electron/runtime-sources.cjs");

export const DESKTOP_NODE_VERSION = "24.18.0";
export const DESKTOP_NODE_ABI = 137;
const PYTHON_VERSION = "3.12.10";
const PIP_VERSION = "25.0.1";
const ASR_MODEL = "onnx-community/whisper-tiny_timestamped";
const ASR_REVISION = "517244293732ee2d58139af5814231b7e6830a0d";
const NLTK_REVISION = "550b6625bcef1f2abff2ff770a5a0d272c9c6b2a";
const ASR_FILES = ["added_tokens.json", "config.json", "generation_config.json", "merges.txt", "normalizer.json", "preprocessor_config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.json", "onnx/encoder_model.onnx", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_q4.onnx", "onnx/decoder_model_merged_quantized.onnx", "README.md"];
export const RESOURCE_PATHS = {
  nodePath: "node/node.exe", klingPackagePath: "cli/node_modules/@klingai/cli-global", elevenLabsPackagePath: "cli/node_modules/@elevenlabs/cli",
  elevenLabsExecutable: "cli/node_modules/@elevenlabs/cli-win32-x64/elevenlabs.exe", alignmentRuntimeDir: "alignment", alignmentPythonPath: "alignment/python/python.exe",
  alignmentModelDir: "alignment/model", alignmentCheckerPath: "alignment/scripts/check-runtime.py", asrModelDir: "asr", wasmDir: "asr/wasm", ffmpegPath: "media/ffmpeg.exe", ffprobePath: "media/ffprobe.exe",
};
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function digest(file, algorithm = "sha256", encoding = "hex") { const hash = createHash(algorithm); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest(encoding); }
async function request(url, { text = false, method = "GET" } = {}) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Official metadata failed (${response.status}): ${url}`);
  if (method === "HEAD") return response;
  return text ? response.text() : response.json();
}
async function downloaded(url, file, expected = {}) {
  if (await exists(file) && (!expected.sha256 || await digest(file) === expected.sha256) && (!expected.size || (await stat(file)).size === expected.size)) return file;
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  console.log(`Lock refresh downloads ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Official download failed (${response.status}): ${url}`);
  const handle = await open(partial, "w");
  let failed;
  try {
    for await (const chunk of response.body) { let written = 0; while (written < chunk.length) written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten; }
  } catch (error) { failed = error; }
  finally { await handle.close(); }
  if (failed) { await rm(partial, { force: true }); throw failed; }
  if (expected.sha256 && await digest(partial) !== expected.sha256 || expected.size && (await stat(partial)).size !== expected.size) { await rm(partial, { force: true }); throw new Error(`Official download checksum/size mismatch: ${url}`); }
  await rename(partial, file); return file;
}
async function fileResource(id, url, localFile, fields, expected = {}) {
  await downloaded(url, localFile, expected);
  return { id, url, size: (await stat(localFile)).size, sha256: await digest(localFile), ...fields };
}
function wheelRank(filename) {
  const match = /-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(filename);
  if (!match || !["win_amd64", "any"].includes(match[3])) return -1;
  const [, python, abi, platform] = match;
  if (python === "cp312" && abi === "cp312" && platform === "win_amd64") return 400;
  const stable = /^cp3(\d+)$/.exec(python);
  if (stable && Number(stable[1]) <= 12 && abi === "abi3") return 300 + Number(stable[1]);
  if (["py3", "py2.py3"].includes(python) && abi === "none") return 100;
  return -1;
}
async function pythonWheel(name, version, cache, role = "python-dependency") {
  const requirement = `${name}==${version}`;
  let url, size, sha256, fileName;
  if (version.endsWith("+cpu")) {
    fileName = `${name.replaceAll("-", "_")}-${version}-cp312-cp312-win_amd64.whl`;
    const indexUrl = `https://download.pytorch.org/whl/cpu/${name}/`;
    const html = await request(indexUrl, { text: true });
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll("&amp;", "&"), indexUrl));
    const selected = links.find(link => decodeURIComponent(link.pathname.split("/").at(-1)) === fileName);
    if (!selected || !/^#sha256=[a-f0-9]{64}$/.test(selected.hash)) throw new Error(`Missing fixed CPU wheel in official PyTorch index: ${fileName}`);
    sha256 = selected.hash.slice(8); selected.hash = ""; url = selected.href;
    const local = join(cache, "wheels-cp312-win_amd64-v1", fileName);
    if (await exists(local)) { size = (await stat(local)).size; if (await digest(local) !== sha256) throw new Error(`Cached CPU wheel does not match upstream SHA256: ${fileName}`); }
    else { const response = await request(url, { method: "HEAD" }); size = Number(response.headers.get("content-length")); }
  } else {
    const metadata = await request(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
    const wheels = metadata.urls.filter(file => file.packagetype === "bdist_wheel" && !file.yanked && wheelRank(file.filename) >= 0).sort((a, b) => wheelRank(b.filename) - wheelRank(a.filename) || a.filename.localeCompare(b.filename, "en"));
    if (!wheels.length) throw new Error(`No compatible official CPython312 Windows x64 wheel: ${requirement}`);
    ({ url, size, filename: fileName } = wheels[0]); sha256 = wheels[0].digests.sha256;
    const local = join(cache, "wheels-cp312-win_amd64-v1", fileName);
    if (await exists(local) && ((await stat(local)).size !== size || await digest(local) !== sha256)) throw new Error(`Cached wheel does not match PyPI metadata: ${fileName}`);
  }
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Official wheel metadata incomplete: ${requirement}`);
  return { id: role === "pip" ? "python-pip" : `python-${slug(name)}`, url, size, sha256, format: "wheel", target: `alignment/wheelhouse/${fileName}`, fileName, role, pythonRequirement: requirement };
}
async function npmResource(name, version, target, cache, stripPrefix = "package") {
  const metadata = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  if (metadata.name !== name || metadata.version !== version || !metadata.dist?.integrity?.startsWith("sha512-")) throw new Error(`Official npm identity/integrity mismatch: ${name}@${version}`);
  const fileName = basename(new URL(metadata.dist.tarball).pathname);
  const local = await downloaded(metadata.dist.tarball, join(cache, "official-npm", `${slug(name)}-${version}.tgz`));
  if (`sha512-${await digest(local, "sha512", "base64")}` !== metadata.dist.integrity) throw new Error(`Official npm integrity mismatch: ${name}@${version}`);
  return { id: slug(name), url: metadata.dist.tarball, size: (await stat(local)).size, sha256: await digest(local), format: "tgz", target, stripPrefix, fileName };
}
async function modelResources({ model, revision, files, target, cache, prefix, pinned = [] }) {
  const metadata = await request(`https://huggingface.co/api/models/${model}/revision/${revision}?blobs=true`);
  const resources = [];
  for (const file of files) {
    const sibling = metadata.siblings.find(item => item.rfilename === file);
    if (!sibling || !Number.isSafeInteger(sibling.size)) throw new Error(`Fixed model file missing: ${model}/${revision}/${file}`);
    const expected = pinned.find(item => item.name === file) || { size: sibling.size, ...(sibling.lfs?.sha256 ? { sha256: sibling.lfs.sha256 } : {}) };
    const url = `https://huggingface.co/${model}/resolve/${revision}/${file}`;
    resources.push(await fileResource(`${prefix}-${slug(file)}`, url, join(cache, file), { format: "file", target: `${target}/${file}` }, expected));
  }
  return resources;
}
async function parallelLimit(values, fn, limit = 6) {
  const results = new Array(values.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) { const current = index++; results[current] = await fn(values[current]); }
  }));
  return results;
}

export async function refreshOfficialSources({ root, cache }) {
  const require = createRequire(join(root, "package.json"));
  const ortRoot = resolve(dirname(require.resolve("onnxruntime-web")), "..");
  const ortVersion = JSON.parse(await readFile(join(ortRoot, "package.json"), "utf8")).version;
  const alignment = JSON.parse(await readFile(join(root, "scripts/alignment/runtime-spec.json"), "utf8"));
  const requirements = (await readFile(join(root, "scripts/lib/desktop-runtime-requirements.txt"), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const resources = [];
  const nodeFile = `node-v${DESKTOP_NODE_VERSION}-win-x64.zip`;
  const nodeUrl = `https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}/${nodeFile}`;
  const sums = await request(`https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}/SHASUMS256.txt`, { text: true });
  const nodeHash = sums.split(/\r?\n/).find(line => line.trim().endsWith(` ${nodeFile}`))?.split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(nodeHash ?? "")) throw new Error("Fixed Node distribution is missing its official SHA256.");
  resources.push(await fileResource("node", nodeUrl, join(cache, nodeFile), { format: "zip", target: "node", stripPrefix: `node-v${DESKTOP_NODE_VERSION}-win-x64` }, { sha256: nodeHash }));
  const pythonFile = `python-${PYTHON_VERSION}-embed-amd64.zip`;
  resources.push(await fileResource("python", `https://www.python.org/ftp/python/${PYTHON_VERSION}/${pythonFile}`, join(cache, "official", pythonFile), { format: "zip", target: "alignment/python" }));
  const pip = await pythonWheel("pip", PIP_VERSION, cache, "pip"); resources.push(pip);
  await downloaded(pip.url, join(cache, "official", pip.fileName), pip);
  resources.push(...await parallelLimit(requirements, requirement => { const [name, version] = requirement.split("=="); return pythonWheel(name, version, cache); }));
  resources.push(...await parallelLimit([
    ["@klingai/cli-global", "0.2.0", RESOURCE_PATHS.klingPackagePath], ["@elevenlabs/cli", "1.8.0", RESOURCE_PATHS.elevenLabsPackagePath],
    ["@elevenlabs/cli-win32-x64", "1.8.0", "cli/node_modules/@elevenlabs/cli-win32-x64"],
    ["onnxruntime-web", ortVersion, "asr/wasm", "package/dist"], ["@ffprobe-installer/win32-x64", "5.1.0", "media"],
  ], ([name, version, target, strip]) => npmResource(name, version, target, cache, strip)));
  resources.push(...await modelResources({ model: alignment.model, revision: alignment.modelRevision, files: [...alignment.modelFiles.map(file => file.name), "README.md"], target: "alignment/model", cache: join(cache, "alignment-model", alignment.modelRevision), prefix: "alignment", pinned: alignment.modelFiles }));
  resources.push(...await modelResources({ model: ASR_MODEL, revision: ASR_REVISION, files: ASR_FILES, target: `asr/${ASR_MODEL}`, cache: join(cache, "asr", ASR_REVISION), prefix: "asr" }));
  resources.push(await fileResource("nltk-english", `https://raw.githubusercontent.com/nltk/nltk_data/${NLTK_REVISION}/packages/tokenizers/punkt_tab.zip`, join(cache, `punkt-tab-${NLTK_REVISION}.zip`), { format: "zip", target: "alignment/nltk-data/tokenizers/punkt_tab/english", stripPrefix: "punkt_tab/english" }, { sha256: "e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106" }));
  const ffmpegVersion = JSON.parse(await readFile(join(root, "node_modules/ffmpeg-static/package.json"), "utf8"))["ffmpeg-static"]["binary-release-tag"];
  const ffmpegBase = `https://github.com/eugeneware/ffmpeg-static/releases/download/${ffmpegVersion}`;
  for (const [id, name, format, target] of [["ffmpeg", "ffmpeg-win32-x64.gz", "gzip", "media/ffmpeg.exe"], ["ffmpeg-license", "win32-x64.LICENSE", "file", "media/notices/ffmpeg/LICENSE"], ["ffmpeg-readme", "win32-x64.README", "file", "media/notices/ffmpeg/README"]]) {
    resources.push(await fileResource(id, `${ffmpegBase}/${name}`, join(cache, "official", name), { format, target }));
  }
  return { schemaVersion: 2, installMode: "official-sources", platform: "win32", arch: "x64", nodeVersion: DESKTOP_NODE_VERSION, nodeAbi: DESKTOP_NODE_ABI, paths: RESOURCE_PATHS,
    python: { version: PYTHON_VERSION, pipResourceId: pip.id, wheelResourceIds: resources.filter(resource => resource.role === "python-dependency").map(resource => resource.id) },
    sources: { pythonProvider: "python.org embeddable", ortVersion, ffmpegVersion, alignmentModel: alignment.model, alignmentRevision: alignment.modelRevision, asrModel: ASR_MODEL, asrRevision: ASR_REVISION, nltkRevision: NLTK_REVISION }, resources: resources.map(withDomesticMirrors) };
}
