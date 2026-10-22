import type { NextConfig } from "next";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const excludedDirectories = new Set([
  // `.next-local` was used by an earlier local launcher and can be left behind
  // as a complete old build. Never trace that legacy output into the current
  // `.next/standalone` bundle.
  ".git", ".github", ".clipforge", ".next-local", "data", "docs", "tasks", "release", "integrations", "e2e", "remotion",
]);

const nextConfig: NextConfig = {
  // Keep every production entry point on the same output directory. In
  // particular, `pnpm build`, `pnpm start`, and start.cmd all use this build.
  distDir: ".next",
  // standalone output: next build additionally emits .next/standalone (minimal server.js + nft-traced dependency subset),
  // used by the Electron main process to fork-start the server without requiring npm install on the user's machine. Does not affect next dev.
  output: "standalone",
  compiler: {
    // Next 16 Turbopack skips route tracing exclusions for instrumentation. Apply
    // the same exclusions before standalone copies its trace, including on Windows.
    async runAfterProductionCompile({ distDir, projectDir }) {
      const traceFile = join(distDir, "server", "instrumentation.js.nft.json");
      let trace: { version: number; files: string[] };
      try { trace = JSON.parse(await readFile(traceFile, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      trace.files = trace.files.filter((file) => {
        const fromProject = relative(projectDir, resolve(dirname(traceFile), file));
        return !excludedDirectories.has(fromProject.split(/[/\\]/)[0]);
      });
      await writeFile(traceFile, JSON.stringify(trace));
    },
  },
  experimental: {
    // API uploads pass through src/proxy.ts. Allow the 80 MiB video limit plus
    // multipart fields/boundaries so Next.js does not truncate the form at 10 MiB.
    proxyClientMaxBodySize: "100mb",
  },
  // better-sqlite3 is a native module; mark it external (loaded via require, so the bundler won't try to bundle its .node file)
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static", "@ffprobe-installer/ffprobe"],
  // Keep the file trace honest: nft's conservative directory collection was dragging the local
  // data/ (user uploads/outputs — 96MB of it), the docs site and other repo-only folders into
  // .next/standalone, which then shipped inside every desktop installer (issue: 330MB dmg).
  // data/ is a runtime-created directory (Electron uses userData anyway), never a build input.
  outputFileTracingExcludes: {
    "/**": Array.from(excludedDirectories, (directory) => `./${directory}/**`),
  },
};

export default nextConfig;
