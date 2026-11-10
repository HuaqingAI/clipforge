const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** Desktop owner lock complements the backend's shared web/desktop service lock. */
function acquireWorkspaceLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filename = path.join(dataDir, ".desktop-service-owner.json");
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filename, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(filename, "utf8")).token === owner.token) fs.unlinkSync(filename);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(filename, "utf8")); }
      catch { throw new Error("工作区服务锁无法读取，请确认旧服务已退出后检查数据目录。"); }
      if (processAlive(previous.pid)) throw new Error("此工作区已有 ClipForge 服务运行，请先退出该服务。");
      fs.unlinkSync(filename);
    }
  }
  throw new Error("无法取得工作区服务锁。");
}

function readLocalJson(url, pathname, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(pathname, url), { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error("健康检查响应过大。"));
      });
      res.once("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error(`健康检查 HTTP ${res.statusCode}`);
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
      res.once("error", reject);
    });
    req.once("timeout", () => req.destroy(new Error("健康检查超时。")));
    req.once("error", reject);
  });
}

function readHealth(url, timeoutMs = 2500) { return readLocalJson(url, "/api/health", timeoutMs); }

function assertHealthy(health, instanceId, nodeAbi) {
  if (health?.app !== "clipforge" || health.instanceId !== instanceId) throw new Error("本地端口上的服务不是此次启动的 ClipForge 实例。");
  if (health.db?.status !== "ok" || health.db.initError || health.db.migrationError) throw new Error(`数据库检查失败：${health.db?.initError || health.db?.migrationError || health.db?.status || "状态缺失"}`);
  if (!health.paths?.dataDirWritable || !health.paths?.migrationsDirExists) throw new Error("数据目录不可写或数据库迁移资源缺失。");
  if (nodeAbi && String(health.runtime?.moduleAbi) !== String(nodeAbi)) throw new Error("后端 Node ABI 与安装资源不一致。");
  if (health.runtime?.electron) throw new Error("后端意外使用了 Electron Node，请修复运行环境。");
  if (health.ffmpeg?.exists !== true) throw new Error("已安装的 FFmpeg 无法读取。");
  if (health.ok === false) throw new Error("本地运行资源检查未通过，请修复安装。");
}

module.exports = { acquireWorkspaceLock, processAlive, readLocalJson, readHealth, assertHealthy };
