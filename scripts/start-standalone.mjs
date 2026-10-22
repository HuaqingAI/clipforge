// Run the standalone build under Node; bundle-standalone.mjs targets Electron's native ABI.
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirName = ".next";
const distDir = join(root, distDirName);
const standalone = join(distDir, "standalone");
const entry = join(standalone, "server.js");

try {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      hostname: { type: "string", short: "H" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log("Usage: pnpm start [--port <port>] [--hostname <hostname>]\nDefaults: PORT or 3000; hostname 127.0.0.1.");
  } else {
    if (!existsSync(entry)) {
      throw new Error(`未找到 ${distDirName}/standalone/server.js，请先执行 pnpm build。`);
    }

    // Resolve Next's own dependency so this works with both hoisted and isolated node_modules.
    const require = createRequire(import.meta.url);
    const nextRequire = createRequire(require.resolve("next/package.json"));
    const { loadEnvConfig } = nextRequire("@next/env");
    process.env.NODE_ENV = "production";
    loadEnvConfig(root, false);

    const port = values.port ?? process.env.PORT ?? "3000";
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error("端口必须是 1 到 65535 之间的整数。");
    }
    process.env.PORT = port;
    // Match next dev's local-only default, even when the OS supplies a machine HOSTNAME.
    process.env.HOSTNAME = values.hostname || "127.0.0.1";

    // server.js changes cwd to standalone: keep existing web data and migrations at the project root.
    process.env.APP_DATA_DIR = resolve(root, process.env.APP_DATA_DIR || "data");
    process.env.APP_MIGRATIONS_DIR = resolve(root, process.env.APP_MIGRATIONS_DIR || "drizzle");

    // Next deliberately omits these from standalone; serve the same assets as next dev/start.
    for (const relative of [join(distDirName, "static"), "public"]) {
      const source = join(root, relative);
      // Node 22's native cpSync can abort on Windows paths containing Chinese.
      if (existsSync(source)) await cp(source, join(standalone, relative), { recursive: true });
    }

    await import(pathToFileURL(entry).href);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
