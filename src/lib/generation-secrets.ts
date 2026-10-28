import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/paths";

// The local key lives alongside the database and must accompany a data-directory backup.
// Task status APIs never return either credentials or the encrypted execution envelope.
function taskKey(): Buffer {
  const directory = getDataDir();
  const filename = join(directory, "generation-task.key");
  mkdirSync(directory, { recursive: true });
  try { writeFileSync(filename, randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const key = readFileSync(filename);
  if (key.length !== 32) throw new Error("后台任务加密密钥无效，请恢复原数据目录中的 generation-task.key。");
  return key;
}

export function encryptGenerationValue(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", taskKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptGenerationValue<T>(value: string): T {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("后台任务快照损坏。");
  const decipher = createDecipheriv("aes-256-gcm", taskKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8")) as T;
}
