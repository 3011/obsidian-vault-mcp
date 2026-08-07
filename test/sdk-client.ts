import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-sdk-"));
const vault = path.join(root, "vault");
await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
await writeFile(path.join(vault, "98-Inbox", "sdk.md"), "# SDK\n\nhello sdk\n", "utf8");

const port = 19191 + Math.floor(Math.random() * 1000);
const projectRoot = path.resolve(import.meta.dirname, "../..");
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: projectRoot,
  env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: "sdk-token", VAULT_ROOT: vault },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

const client = new Client({ name: "obsidian-vault-mcp-sdk-test", version: "0.1.0" });

try {
  await waitForHealth(port);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: {
        Authorization: "Bearer sdk-token"
      }
    }
  });

  await client.connect(transport as any);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert(toolNames.includes("vault_read"));
  assert(toolNames.includes("vault_write"));
  assert(toolNames.includes("vault_create_note"));
  assert(toolNames.includes("vault_replace_note"));
  assert(toolNames.includes("vault_delete"));
  assert(toolNames.includes("search_simple"));
  for (const tool of tools.tools) {
    assert(tool.outputSchema && tool.outputSchema.type === "object", `missing object outputSchema for ${tool.name}`);
  }

  const expectedAnnotations: Record<string, Record<string, boolean>> = {
    vault_list: readOnlyAnnotations(),
    vault_list_detailed: readOnlyAnnotations(),
    vault_read: readOnlyAnnotations(),
    vault_write: annotations(false, true, false),
    vault_create_note: annotations(false, false, true),
    vault_replace_note: annotations(false, true, true),
    vault_append: annotations(false, false, false),
    vault_create_directory: annotations(false, false, true),
    vault_patch: annotations(false, true, false),
    vault_delete: annotations(false, true, true),
    vault_move: annotations(false, true, true),
    vault_get_operation: readOnlyAnnotations(),
    vault_get_document_map: readOnlyAnnotations(),
    search_simple: readOnlyAnnotations(),
    search_query: readOnlyAnnotations(),
    find_asset_references: readOnlyAnnotations(),
    asset_audit: readOnlyAnnotations(),
    tag_list: readOnlyAnnotations(),
    append_to_inbox: annotations(false, false, false),
    vault_import_file: annotations(false, true, false, true),
    vault_export_file: annotations(true, false, true, true),
    vault_create_external_reference_note: annotations(false, true, false)
  };
  assert.equal(tools.tools.length, Object.keys(expectedAnnotations).length);
  for (const tool of tools.tools) {
    assert.deepEqual(tool.annotations, expectedAnnotations[tool.name], `incorrect annotations for ${tool.name}`);
  }

  const readResult = await client.callTool({
    name: "vault_read",
    arguments: { path: "98-Inbox/sdk.md" }
  });
  assert.equal(readResult.isError, false);
  assert.match(textOf(readResult), /hello sdk/);

  const writeResult = await client.callTool({
    name: "vault_write",
    arguments: { path: "98-Inbox/sdk-write.md", content: "# SDK Write\n\nneedle sdk\n" }
  });
  assert.equal(writeResult.isError, false);
  const writeStructured = writeResult.structuredContent as Record<string, any> | undefined;
  assert.equal(writeStructured?.ok, true);
  assert.equal(writeStructured?.executionMode, "synchronous");
  assert.equal(writeStructured?.status, "succeeded");
  assert.match(String(writeStructured?.revision?.sha256), /^[0-9a-f]{64}$/);

  const inboxResult = await client.callTool({
    name: "append_to_inbox",
    arguments: { title: "SDK Inbox", content: "captured from sdk test\n" }
  });
  assert.equal(inboxResult.isError, false);
  const inboxStructured = inboxResult.structuredContent as Record<string, unknown> | undefined;
  assert.equal(inboxStructured?.message, "OK");
  assert.equal(inboxStructured?.path, "98-Inbox/SDK Inbox.md");

  const searchResult = await client.callTool({
    name: "search_simple",
    arguments: { query: "needle sdk" }
  });
  assert.equal(searchResult.isError, false);
  assert.match(textOf(searchResult), /98-Inbox\/sdk-write.md/);

  await client.close();
  console.log("sdk client compatibility ok");
} finally {
  child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}

function annotations(readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint = false): Record<string, boolean> {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

function readOnlyAnnotations(): Record<string, boolean> {
  return annotations(true, false, true);
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  const first = content?.[0];
  assert(first && first.type === "text" && typeof first.text === "string");
  return first.text;
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}
