import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

export type TestServer = {
  root: string;
  vault: string;
  port: number;
  child: ChildProcess;
  close: () => Promise<void>;
};

export async function createVaultServer(env: Record<string, string> = {}): Promise<TestServer> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-test-"));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const projectRoot = path.resolve(import.meta.dirname, "../..");
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: projectRoot,
    env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: "test-token", VAULT_ROOT: vault, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        return {
          root,
          vault,
          port,
          child,
          close: async () => {
            child.kill("SIGTERM");
            await rm(root, { recursive: true, force: true });
          }
        };
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
  throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

export async function rpc(port: number, body: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "authorization": "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.status !== 200) throw new Error(await res.text());
  return res.json();
}

export async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return unwrapStructuredContent(response.result.structuredContent);
}

export async function expectToolError(port: number, name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, true, JSON.stringify(response));
  assert.match(response.result.content[0].text, pattern);
}

export async function expectInvalidArguments(port: number, name: string, args: Record<string, unknown>, pattern?: RegExp): Promise<void> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.error?.code, -32602, JSON.stringify(response));
  assert.equal(response.error?.data?.errorCode, "INVALID_ARGUMENT", JSON.stringify(response));
  if (pattern) assert.match(JSON.stringify(response.error?.data?.issues ?? []), pattern);
}

function unwrapStructuredContent(value: any): any {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && "result" in value) return value.result;
  return value;
}
