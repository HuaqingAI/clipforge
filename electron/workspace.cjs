// Open a complete legacy workspace in place: encrypted snapshots and absolute
// media references keep their original paths. Never copy just sqlite.db.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function resolveWorkspaceSelection(selectedDir, { ownedPid, nodePath } = {}) {
  if (typeof selectedDir !== "string" || !path.isAbsolute(selectedDir) || /[\0\r\n]/.test(selectedDir)) throw new Error("请选择旧版 ClipForge 工作目录或完整 data 目录。");
  const selected = fs.realpathSync(selectedDir);
  let dataDir = selected;
  if (fs.existsSync(path.join(selected, "data", "sqlite.db"))) dataDir = fs.realpathSync(path.join(selected, "data"));
  const database = path.join(dataDir, "sqlite.db");
  if (!fs.existsSync(database) || !fs.statSync(database).isFile()) throw new Error("目录中没有 sqlite.db，请选择原项目目录或它的完整 data 目录。");
  if (!fs.statSync(dataDir).isDirectory()) throw new Error("工作目录不可用。");
  const sourceRoot = path.dirname(dataDir);
  const legacyLock = readJson(path.join(sourceRoot, ".clipforge", "launcher.lock"));
  if (alive(legacyLock?.pid)) throw new Error("旧版 Web 服务仍在运行，请先在启动控制台按 Ctrl+C 停止，再打开此工作目录。");
  const owner = readJson(path.join(dataDir, ".clipforge-service.lock"));
  if (alive(owner?.pid) && owner.pid !== process.pid && owner.pid !== ownedPid) throw new Error("该工作目录正在由另一个 ClipForge 服务使用，请先停止它。");
  const taskKey = path.join(dataDir, "generation-task.key");
  if (fs.existsSync(taskKey) && fs.statSync(taskKey).size !== 32) throw new Error("generation-task.key 已损坏，请恢复原始密钥后再打开旧工作目录。");
  if (nodePath && !fs.existsSync(taskKey)) {
    const needsKey = execFileSync(nodePath, ["-e", "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});const table=db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_items'\").get();console.log(Boolean(table&&db.prepare('SELECT 1 FROM generation_items LIMIT 1').get()));db.close()", database], { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, NODE_NO_WARNINGS: "1", NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "" } }).trim();
    if (needsKey === "true") throw new Error("旧工作目录缺少 generation-task.key，无法恢复历史任务，请还原原始完整 data 目录。");
  }
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
  return { dataDir, sourceRoot };
}
function loadWorkspace(userDataDir, options) {
  const configPath = path.join(userDataDir, "workspace.json");
  let content;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("无法读取工作目录配置，请检查 workspace.json。", { cause: error });
  }
  let config;
  try {
    config = JSON.parse(content);
  } catch (error) {
    throw new Error("工作目录配置无效，请恢复 workspace.json。", { cause: error });
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || config.schemaVersion !== 1 || typeof config.dataDir !== "string" || !path.isAbsolute(config.dataDir)) throw new Error("工作目录配置无效，请恢复 workspace.json。");
  return resolveWorkspaceSelection(config.dataDir, options).dataDir;
}
function saveWorkspace(userDataDir, dataDir) {
  const selected = resolveWorkspaceSelection(dataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const target = path.join(userDataDir, "workspace.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, dataDir: selected.dataDir }, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
  return selected.dataDir;
}
module.exports = { resolveWorkspaceSelection, loadWorkspace, saveWorkspace };
