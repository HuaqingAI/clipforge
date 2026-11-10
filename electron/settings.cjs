const fs = require("node:fs");
const path = require("node:path");

const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;

function applicationKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 512 &&
    /^(?:daihuo-jianshou-|clipforge[:_-])/i.test(key) && !/[\x00-\x1f]/.test(key);
}

/** Browser settings live outside Chromium origins; secrets are encrypted by the OS. */
function createSettingsStore(directory, encryption) {
  const filename = path.join(directory, "browser-storage.json");
  let values;
  function requireEncryption() {
    if (!encryption.isEncryptionAvailable() || encryption.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("系统凭据加密不可用，请解锁系统凭据库后重试；配置未写入明文文件。");
    }
  }
  function load() {
    if (values) return values;
    requireEncryption();
    if (!fs.existsSync(filename)) return values = Object.create(null);
    const envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (envelope.version !== 1 || typeof envelope.encrypted !== "string") throw new Error("客户端配置格式无效，请恢复配置备份。");
    const decoded = JSON.parse(encryption.decryptString(Buffer.from(envelope.encrypted, "base64")));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("客户端配置内容无效。");
    values = Object.create(null);
    for (const [key, value] of Object.entries(decoded)) {
      if (applicationKey(key) && typeof value === "string") values[key] = value;
    }
    return values;
  }
  function save(next) {
    requireEncryption();
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("客户端配置超过存储上限。");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, encrypted: encryption.encryptString(serialized).toString("base64") }), { mode: 0o600 });
      fs.renameSync(temporary, filename);
      values = next;
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  function validKey(key) { if (!applicationKey(key)) throw new Error("不允许访问此配置项。"); }
  return {
    getItem(key) { validKey(key); return load()[key] ?? null; },
    setItem(key, value) {
      validKey(key);
      if (typeof value !== "string" || Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error("配置内容过大或格式无效。");
      save(Object.assign(Object.create(null), load(), { [key]: value }));
    },
    removeItem(key) { validKey(key); const next = Object.assign(Object.create(null), load()); delete next[key]; save(next); },
    keys() { return Object.keys(load()); },
  };
}

module.exports = { applicationKey, createSettingsStore };
