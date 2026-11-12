// @vitest-environment node
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const retired = ["clipforge_create_video", "clipforge_generate_script", "clipforge_product_script"];

describe("external creation callers", () => {
  it("rejects the retired CLI creation commands without contacting the app", async () => {
    for (const command of ["create", "product"]) {
      await expect(execute(process.execPath, [join(process.cwd(), "bin/clipforge.mjs"), command], {
        env: { ...process.env, CLIPFORGE_BASE_URL: "http://127.0.0.1:1" },
      })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`未知命令：${command}`) });
    }
  });

  it("exposes TIDEWE ingestion while removing sales script and topic tools", async () => {
    const requests: Array<{ path?: string; body: unknown }> = [];
    const server: Server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ projectId: "tidewe-project", product: { title: "Outdoor gear" }, productImages: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const client = new Client({ name: "creation-regression", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "mcp/clipforge-mcp.mjs")],
      env: { ...process.env as Record<string, string>, CLIPFORGE_BASE_URL: `http://127.0.0.1:${port}` },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["clipforge_ingest_product", "clipforge_compose", "clipforge_get_video"]));
      for (const name of retired) expect(names).not.toContain(name);
      await client.callTool({ name: "clipforge_ingest_product", arguments: { url: "https://example.test/gear" } });
      expect(requests).toEqual([{
        path: "/api/ingest/product",
        body: { url: "https://example.test/gear", createProject: true, creativeProfile: { creationType: "tidewe_outdoor" } },
      }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15000);
});
