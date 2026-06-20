import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-"));
const vault = path.join(root, "vault");
const outside = path.join(root, "outside.md");
await mkdir(path.join(vault, "98-Inbox"), { recursive: true });
await mkdir(path.join(vault, "Projects"), { recursive: true });
await writeFile(outside, "outside secret", "utf8");
await symlink(outside, path.join(vault, "98-Inbox", "link.md"));
await writeFile(path.join(vault, "98-Inbox", "fixture.md"), `---
title: Fixture
tags:
  - integration
  - project/active
priority: 42
active: true
---

# Alpha

hello alpha #inline-tag

## Subsection

sub text

# Beta

beta block ^beta-block

needle one
needle two

# Gamma

last section
`, "utf8");

const port = 18181 + Math.floor(Math.random() * 1000);
const projectRoot = path.resolve(import.meta.dirname, "../..");
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: projectRoot,
  env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(port), MCP_TOKEN: "test-token", VAULT_ROOT: vault, MAX_REQUEST_BYTES: "4096" },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  await waitForHealth(port);
  await testAuth(port);
  await testProtocolBasics(port);
  await testMalformedJsonAndNullId(port);
  await testWellKnownMetadata(port);
  await testToolDiscovery(port);
  await testRequestBodyLimit(port);
  await testVaultList(port);
  await testVaultRead(port);
  await testDocumentMap(port);
  await testWriteAppendMoveDelete(port);
  await testPatch(port);
  await testSearchAndTags(port);
  await testAppendToInbox(port);
  await testSecurityBoundaries(port);
  await testReadOnlyMode();
  console.log("integration ok");
} finally {
  child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}

async function testAuth(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  assert.equal(res.status, 401);
  const auth = res.headers.get("www-authenticate");
  assert(auth?.includes(`resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`));
}

async function testProtocolBasics(port: number): Promise<void> {
  const initialize = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" }
  });
  assert.equal(initialize.result.protocolVersion, "2025-06-18");
  assert.equal(initialize.result.serverInfo.name, "obsidian-vault-mcp");
  assert.deepEqual(initialize.result.capabilities, { tools: {} });

  const ping = await rpc(port, { jsonrpc: "2.0", id: 2, method: "ping", params: {} });
  assert.deepEqual(ping.result, {});

  const get = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: "Bearer test-token", accept: "text/event-stream" }
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");

  const unsupported = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "mcp-protocol-version": "1999-01-01"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} })
  });
  assert.equal(unsupported.status, 400);
  const unsupportedBody = await unsupported.json() as any;
  assert.equal(unsupportedBody.error, "unsupported_protocol_version");
  assert(Array.isArray(unsupportedBody.supported));
}

async function testMalformedJsonAndNullId(port: number): Promise<void> {
  const malformed = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":"
  });
  assert.equal(malformed.status, 200);
  const malformedBody = await malformed.json() as any;
  assert.equal(malformedBody.error.code, -32700);

  const nullId = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" })
  });
  assert.equal(nullId.status, 200);
  const nullIdBody = await nullId.json() as any;
  assert.equal(nullIdBody.error.code, -32600);
}

async function testWellKnownMetadata(port: number): Promise<void> {
  for (const pathname of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(typeof body.resource, "string");
    assert(body.resource.startsWith("http://127.0.0.1:"));
  }

  const noAuthPort = port + 3000;
  const noAuthChild = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: projectRoot,
    env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(noAuthPort), MCP_REQUIRE_TOKEN: "false", VAULT_ROOT: vault },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(noAuthPort);
    for (const pathname of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`http://127.0.0.1:${noAuthPort}${pathname}`);
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(typeof body.resource, "string");
      assert(body.resource.startsWith("http://127.0.0.1:"));
    }
  } finally {
    noAuthChild.kill("SIGTERM");
  }
}

async function testToolDiscovery(port: number): Promise<void> {
  const tools = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = tools.result.tools.map((tool: any) => tool.name);
  for (const expected of [
    "vault_list",
    "vault_read",
    "vault_write",
    "vault_append",
    "vault_patch",
    "vault_delete",
    "vault_move",
    "vault_get_document_map",
    "search_simple",
    "tag_list",
    "append_to_inbox",
    "vault_upload_image_asset",
    "vault_create_note_with_assets",
    "vault_create_external_reference_note"
  ]) {
    assert(names.includes(expected), `missing tool ${expected}`);
  }
}

async function testRequestBodyLimit(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "authorization": "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_write", arguments: { path: "98-Inbox/too-large.md", content: "x".repeat(5000) } } })
  });
  assert.equal(res.status, 413);
}

async function testVaultList(port: number): Promise<void> {
  const rootList = await callTool(port, "vault_list", {});
  assert(rootList.files.includes("98-Inbox/"));
  assert(rootList.files.includes("Projects/"));
  const inbox = await callTool(port, "vault_list", { path: "98-Inbox" });
  assert(inbox.files.includes("fixture.md"));
}

async function testVaultRead(port: number): Promise<void> {
  const full = await callTool(port, "vault_read", { path: "98-Inbox/fixture.md" });
  assert.equal(full.path, "98-Inbox/fixture.md");
  assert.equal(full.frontmatter.title, "Fixture");
  assert.equal(full.frontmatter.priority, 42);
  assert(full.tags.includes("integration"));
  assert(full.tags.includes("inline-tag"));
  assert.match(full.content, /hello alpha/);

  const heading = await callToolText(port, "vault_read", { path: "98-Inbox/fixture.md", targetType: "heading", target: "Alpha" });
  assert.match(heading, /hello alpha/);
  assert.doesNotMatch(heading, /last section/);

  const nested = await callToolText(port, "vault_read", { path: "98-Inbox/fixture.md", targetType: "heading", target: "Alpha::Subsection" });
  assert.match(nested, /sub text/);
  assert.doesNotMatch(nested, /hello alpha/);

  const block = await callToolText(port, "vault_read", { path: "98-Inbox/fixture.md", targetType: "block", target: "beta-block" });
  assert.match(block, /\^beta-block/);

  const frontmatter = await callTool(port, "vault_read", { path: "98-Inbox/fixture.md", targetType: "frontmatter", target: "priority" });
  assert.equal(frontmatter, 42);

  await expectToolError(port, "vault_read", { path: "98-Inbox/missing.md" }, /no such file|ENOENT/i);
}

async function testDocumentMap(port: number): Promise<void> {
  const map = await callTool(port, "vault_get_document_map", { path: "98-Inbox/fixture.md" });
  assert(map.headings.includes("Alpha"));
  assert(map.headings.includes("Alpha::Subsection"));
  assert(map.blocks.includes("beta-block"));
  assert(map.frontmatterFields.includes("title"));
  assert(map.tags.includes("project/active"));
}

async function testWriteAppendMoveDelete(port: number): Promise<void> {
  await callTool(port, "vault_write", { path: "Projects/write.md", content: "# Written\n\nneedle-write\n" });
  assert.match(await readFile(path.join(vault, "Projects", "write.md"), "utf8"), /needle-write/);
  await callTool(port, "vault_append", { path: "Projects/write.md", content: "appendix\n" });
  assert.match(await readFile(path.join(vault, "Projects", "write.md"), "utf8"), /appendix/);

  await callTool(port, "vault_move", { path: "Projects/write.md", destination: "Projects/Nested/" });
  assert.match(await readFile(path.join(vault, "Projects", "Nested", "write.md"), "utf8"), /needle-write/);

  await callTool(port, "vault_write", { path: "Projects/existing.md", content: "existing\n" });
  await expectToolError(port, "vault_move", { path: "Projects/Nested/write.md", destination: "Projects/existing.md" }, /destination already exists/i);
  await callTool(port, "vault_move", { path: "Projects/Nested/write.md", destination: "Projects/existing.md", allowOverwrite: true });
  assert.match(await readFile(path.join(vault, "Projects", "existing.md"), "utf8"), /needle-write/);

  await callTool(port, "vault_delete", { path: "Projects/existing.md" });
  await expectToolError(port, "vault_read", { path: "Projects/existing.md" }, /no such file|ENOENT/i);
}

async function testPatch(port: number): Promise<void> {
  await callTool(port, "vault_write", { path: "98-Inbox/patch.md", content: `---
tags:
  - old
---

# Alpha

old alpha

# Beta

line ^block-a
` });

  await callTool(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "heading",
    target: "Alpha",
    operation: "append",
    content: "appended alpha\n",
    rejectIfContentPreexists: true
  });
  await expectToolError(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "heading",
    target: "Alpha",
    operation: "append",
    content: "appended alpha\n",
    rejectIfContentPreexists: true
  }, /already exists/i);

  await callTool(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "heading",
    target: "Beta",
    operation: "replace",
    content: "new beta\n"
  });
  let read = await callTool(port, "vault_read", { path: "98-Inbox/patch.md" });
  assert.match(read.content, /new beta/);
  assert.doesNotMatch(read.content, /line \^block-a/);

  await callTool(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "heading",
    target: "New::Nested",
    operation: "append",
    content: "created nested\n",
    createTargetIfMissing: true
  });
  read = await callTool(port, "vault_read", { path: "98-Inbox/patch.md" });
  assert.match(read.content, /# New/);
  assert.match(read.content, /## Nested/);
  assert.match(read.content, /created nested/);

  await callTool(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "frontmatter",
    target: "tags",
    operation: "append",
    contentType: "application/json",
    content: ["new-tag"]
  });
  await callTool(port, "vault_patch", {
    path: "98-Inbox/patch.md",
    targetType: "frontmatter",
    target: "priority",
    operation: "replace",
    contentType: "application/json",
    content: 7,
    createTargetIfMissing: true
  });
  read = await callTool(port, "vault_read", { path: "98-Inbox/patch.md" });
  assert.deepEqual(read.frontmatter.tags, ["old", "new-tag"]);
  assert.equal(read.frontmatter.priority, 7);

  await callTool(port, "vault_write", { path: "98-Inbox/block.md", content: "# Blocks\n\nline ^block-a\n" });
  await callTool(port, "vault_patch", {
    path: "98-Inbox/block.md",
    targetType: "block",
    target: "block-a",
    operation: "append",
    content: "after block\n"
  });
  read = await callTool(port, "vault_read", { path: "98-Inbox/block.md" });
  assert.match(read.content, /after block/);

  await callTool(port, "vault_patch", {
    path: "98-Inbox/block.md",
    targetType: "block",
    target: "block-a",
    operation: "replace",
    content: "^block-b",
    targetScope: "marker"
  });
  read = await callTool(port, "vault_read", { path: "98-Inbox/block.md" });
  assert.match(read.content, /\^block-b/);
  assert.doesNotMatch(read.content, /\^block-a/);
}

async function testSearchAndTags(port: number): Promise<void> {
  const search = await callTool(port, "search_simple", { query: "needle", limit: 5 });
  const fixture = search.find((item: any) => item.filename === "98-Inbox/fixture.md");
  assert(fixture);
  assert.equal(fixture.matches.length, 2);
  const filenameSearch = await callTool(port, "search_simple", { query: "fixture" });
  assert(filenameSearch.some((item: any) => item.matches.some((match: any) => match.match.source === "filename")));

  const tags = await callTool(port, "tag_list", {});
  assert(tags.tags.some((tag: any) => tag.name === "integration"));
  assert(tags.tags.some((tag: any) => tag.name === "project"));
  assert(tags.tags.some((tag: any) => tag.name === "project/active"));
  assert(tags.tags.some((tag: any) => tag.name === "inline-tag"));
}

async function testAppendToInbox(port: number): Promise<void> {
  const result = await callTool(port, "append_to_inbox", { title: "Daily Capture", content: "inbox content\n" });
  assert.equal(result.path, "98-Inbox/Daily Capture.md");
  assert.match(await readFile(path.join(vault, result.path), "utf8"), /inbox content/);
}

async function testSecurityBoundaries(port: number): Promise<void> {
  await expectToolError(port, "vault_read", { path: "../outside.md" }, /traversal/i);
  await expectToolError(port, "vault_write", { path: ".obsidian/config.md", content: "bad" }, /not allowed/i);
  await expectToolError(port, "vault_read", { path: "98-Inbox/link.md" }, /regular file/i);
  await expectToolError(port, "vault_move", { path: "98-Inbox/fixture.md", destination: "../moved.md" }, /traversal/i);
}

async function testReadOnlyMode(): Promise<void> {
  const readOnlyPort = port + 2000;
  const readOnlyChild = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: projectRoot,
    env: { ...process.env, MCP_HOST: "127.0.0.1", MCP_PORT: String(readOnlyPort), MCP_TOKEN: "test-token", VAULT_ROOT: vault, READ_ONLY: "true" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(readOnlyPort);
    const tools = await rpc(readOnlyPort, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = tools.result.tools.map((tool: any) => tool.name);
    assert(names.includes("vault_read"));
    assert(names.includes("search_simple"));
    assert(!names.includes("vault_write"));
    assert(!names.includes("vault_delete"));
    assert(!names.includes("vault_upload_image_asset"));
    assert(!names.includes("vault_create_note_with_assets"));
    assert(!names.includes("vault_create_external_reference_note"));
    const response = await rpc(readOnlyPort, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_write", arguments: { path: "98-Inbox/nope.md", content: "nope" } } });
    assert.equal(response.error?.code, -32601);
  } finally {
    readOnlyChild.kill("SIGTERM");
  }
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

async function rpc(port: number, body: any): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "authorization": "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.status !== 200) {
    throw new Error(await res.text());
  }
  return res.json();
}

async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return unwrapStructuredContent(response.result.structuredContent);
}

async function callToolText(port: number, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  return response.result.content[0].text;
}

async function expectToolError(port: number, name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.result.isError, true, JSON.stringify(response));
  assert.match(response.result.content[0].text, pattern);
}

function unwrapStructuredContent(value: any): any {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && "result" in value) {
    return value.result;
  }
  return value;
}
