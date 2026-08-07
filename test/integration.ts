import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-"));
const vault = path.join(root, "vault");
const outside = path.join(root, "outside.md");
await mkdir(path.join(vault, "98-Inbox"), { recursive: true });
await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
await mkdir(path.join(vault, "98-Inbox", "empty-dir"), { recursive: true });
await mkdir(path.join(vault, "98-Inbox", "non-empty-dir"), { recursive: true });
await mkdir(path.join(vault, "Projects", "Nested"), { recursive: true });
await mkdir(path.join(vault, "Projects", "assets"), { recursive: true });
await mkdir(path.join(vault, "Projects", "NoAssets"), { recursive: true });
await mkdir(path.join(vault, "Other"), { recursive: true });
await writeFile(outside, "outside secret", "utf8");
await symlink(outside, path.join(vault, "98-Inbox", "link.md"));
await writeFile(path.join(vault, "98-Inbox", "assets", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
await writeFile(path.join(vault, "98-Inbox", "assets", "orphan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
await writeFile(path.join(vault, "98-Inbox", "assets", "my image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
await writeFile(path.join(vault, "98-Inbox", "assets", "截图 2026.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]));
await writeFile(path.join(vault, "98-Inbox", "assets", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x04]));
await writeFile(path.join(vault, "Projects", "assets", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x05]));
await writeFile(path.join(vault, "98-Inbox", "plain.txt"), "plain text\n", "utf8");
await writeFile(path.join(vault, "98-Inbox", "non-empty-dir", "child.txt"), "child\n", "utf8");
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
await writeFile(path.join(vault, "Projects", "asset-refs.md"), `# Asset Refs

![[98-Inbox/assets/pixel.png]]
![[my image.png|Image Alias]]
![[截图 2026.png#preview|中文 Alias]]
![encoded](../98-Inbox/assets/my%20image.png "title")
<img src="../98-Inbox/assets/截图%202026.png">
![[a.png]]

\`\`\`md
![[orphan.png]]
\`\`\`

This plain text mentions orphan.png but is not a reference.
`, "utf8");

const port = 18181 + Math.floor(Math.random() * 1000);
const projectRoot = path.resolve(import.meta.dirname, "../..");
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    MCP_HOST: "127.0.0.1",
    MCP_PORT: String(port),
    MCP_TOKEN: "test-token",
    VAULT_ROOT: vault,
    MAX_REQUEST_BYTES: "4096"
  },
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
  await testAssetAuditTools(port);
  await testWriteAppendMoveDelete(port);
  await testDirectoryPolicy(port);
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
    "vault_list_detailed",
    "vault_read",
    "vault_write",
    "vault_create_note",
    "vault_replace_note",
    "vault_append",
    "vault_patch",
    "vault_delete",
    "vault_move",
    "vault_create_directory",
    "vault_get_document_map",
    "search_simple",
    "search_query",
    "find_asset_references",
    "asset_audit",
    "tag_list",
    "append_to_inbox",
    "vault_import_file",
    "vault_export_file",
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
  assert(inbox.files.includes("assets/"));
  assert(inbox.files.includes("plain.txt"));
  const assets = await callTool(port, "vault_list", { path: "98-Inbox/assets" });
  assert(assets.files.includes("pixel.png"));
}

async function testAssetAuditTools(port: number): Promise<void> {
  const detailed = await callTool(port, "vault_list_detailed", { path: "98-Inbox/assets", recursive: false, includeSha256: true });
  assert.equal(detailed.exists, true);
  assert.equal(detailed.kind, "directory");
  assert.equal(detailed.isEmpty, false);
  assert(detailed.entryCount >= 5);
  const pixelEntry = detailed.entries.find((entry: any) => entry.path === "98-Inbox/assets/pixel.png");
  assert(pixelEntry);
  assert.equal(pixelEntry.mime, "image/png");
  assert.equal(pixelEntry.isAttachment, true);
  assert.equal(typeof pixelEntry.sha256, "string");

  const empty = await callTool(port, "vault_list_detailed", { path: "98-Inbox/empty-dir" });
  assert.equal(empty.exists, true);
  assert.equal(empty.kind, "directory");
  assert.equal(empty.isEmpty, true);
  assert.deepEqual(empty.entries, []);

  const missing = await callTool(port, "vault_list_detailed", { path: "98-Inbox/missing-assets" });
  assert.equal(missing.exists, false);
  assert.equal(missing.kind, "missing");

  const denied = await callTool(port, "vault_list_detailed", { path: ".obsidian" });
  assert.equal(denied.kind, "denied");

  const refs = await callTool(port, "find_asset_references", {
    assetPaths: [
      "98-Inbox/assets/pixel.png",
      "98-Inbox/assets/orphan.png",
      "98-Inbox/assets/my image.png",
      "98-Inbox/assets/截图 2026.png",
      "98-Inbox/assets/a.png",
      "Projects/assets/a.png",
      "98-Inbox/assets/missing.png"
    ]
  });
  assert.equal(refs.scanCompleteness, "full_vault");
  const pixel = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/pixel.png");
  assert.equal(pixel.trashSafety, "unsafe");
  assert.equal(pixel.references[0].resolution, "exact_path");

  const orphan = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/orphan.png");
  assert.equal(orphan.candidateOrphan, true);
  assert.equal(orphan.trashSafety, "safe");
  assert.equal(orphan.referencedByCount, 0);

  const spaced = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/my image.png");
  assert.equal(spaced.trashSafety, "unsafe");
  assert(spaced.references.some((reference: any) => reference.referenceType === "wikilink_embed"));
  assert(spaced.references.some((reference: any) => reference.referenceType === "markdown_image"));

  const chinese = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/截图 2026.png");
  assert.equal(chinese.trashSafety, "unsafe");
  assert(chinese.references.some((reference: any) => reference.referenceType === "html_img"));

  const ambiguousInbox = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/a.png");
  const ambiguousProject = refs.results.find((item: any) => item.assetPath === "Projects/assets/a.png");
  assert.equal(ambiguousInbox.ambiguous, true);
  assert.equal(ambiguousInbox.trashSafety, "unknown");
  assert.equal(ambiguousProject.ambiguous, true);
  assert.equal(ambiguousProject.trashSafety, "unknown");

  const missingAsset = refs.results.find((item: any) => item.assetPath === "98-Inbox/assets/missing.png");
  assert.equal(missingAsset.exists, false);
  assert.equal(missingAsset.trashSafety, "unknown");

  const scoped = await callTool(port, "find_asset_references", { assetPaths: ["98-Inbox/assets/orphan.png"], scope: "Projects" });
  assert.equal(scoped.scanCompleteness, "scoped");
  assert.equal(scoped.results[0].candidateOrphan, true);
  assert.equal(scoped.results[0].trashSafety, "unknown");

  const audit = await callTool(port, "asset_audit", { root: "98-Inbox/assets", recursive: true });
  assert.equal(audit.scanCompleteness, "full_vault");
  assert(audit.summary.totalAssets >= 5);
  assert(audit.summary.safeToTrash >= 1);
  assert(audit.summary.unknown >= 1);
  const auditedOrphan = audit.assets.find((item: any) => item.path === "98-Inbox/assets/orphan.png");
  assert.equal(auditedOrphan.trashSafety, "safe");
  const auditedAmbiguous = audit.assets.find((item: any) => item.path === "98-Inbox/assets/a.png");
  assert.equal(auditedAmbiguous.trashSafety, "unknown");
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

  const plain = await callTool(port, "vault_read", { path: "98-Inbox/plain.txt" });
  assert.equal(plain.path, "98-Inbox/plain.txt");
  assert.match(plain.content, /plain text/);
  await expectToolError(port, "vault_read", { path: "98-Inbox/assets/pixel.png" }, /binary files cannot be read/i);
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

  await callTool(port, "vault_move", { path: "98-Inbox/assets/pixel.png", destination: "Projects/assets/" });
  const movedAsset = await readFile(path.join(vault, "Projects", "assets", "pixel.png"));
  assert.equal(movedAsset[1], 0x50);
  await callTool(port, "vault_delete", { path: "Projects/assets/pixel.png" });
  await expectToolError(port, "vault_read", { path: "Projects/assets/pixel.png" }, /no such file|ENOENT/i);

  await expectToolError(port, "vault_delete", { path: "98-Inbox/non-empty-dir" }, /not empty|ENOTEMPTY|EEXIST/i);
  await callTool(port, "vault_delete", { path: "98-Inbox/empty-dir" });
  await expectToolError(port, "vault_list", { path: "98-Inbox/empty-dir" }, /directory not found/i);
  await expectToolError(port, "vault_move", { path: "98-Inbox/fixture.md", destination: "98-Inbox/fixture.txt" }, /Markdown and non-Markdown/i);
}

async function testDirectoryPolicy(port: number): Promise<void> {
  const created = await callTool(port, "vault_create_directory", {
    parent: "Projects",
    name: "Agent-Created",
    reason: "Existing project directories do not match this new independent workstream."
  });
  assert.equal(created.path, "Projects/Agent-Created");
  const createdStat = await stat(path.join(vault, created.path));
  assert.equal(createdStat.isDirectory(), true);
  await callTool(port, "vault_write", { path: "Projects/Agent-Created/note.md", content: "created after deliberate classification\n" });
  assert.match(await readFile(path.join(vault, "Projects", "Agent-Created", "note.md"), "utf8"), /deliberate classification/);

  await expectToolError(port, "vault_create_directory", {
    parent: "Projects",
    name: "Agent-Created",
    reason: "Trying the same directory again."
  }, /directory already exists.*reuse the existing directory/i);

  await expectToolError(port, "vault_create_directory", {
    parent: "Projects",
    name: "Nested/Child",
    reason: "This should be created one level at a time."
  }, /single path segment|one level at a time/i);

  await expectInvalidArguments(port, "vault_create_directory", {
    parent: "Projects",
    name: "x".repeat(201),
    reason: "The directory name exceeds the server-side limit."
  }, /must NOT have more than 200 characters|maxLength/i);

  await expectToolError(port, "vault_create_directory", {
    parent: "Projects",
    name: "中".repeat(86),
    reason: "The directory name exceeds the filesystem UTF-8 byte limit."
  }, /must not exceed 255 UTF-8 bytes/i);

  for (const invalidName of ["bad:name", "trailing.", "CON"]) {
    await expectToolError(port, "vault_create_directory", {
      parent: "Projects",
      name: invalidName,
      reason: "This directory name is not portable across Obsidian desktop platforms."
    }, /not portable|reserved on Windows/i);
  }

  await expectToolError(port, "vault_create_directory", {
    parent: "Projects/Missing-Parent",
    name: "Child",
    reason: "The parent does not exist."
  }, /parent directory not found/i);
  await assert.rejects(() => stat(path.join(vault, "Projects", "Missing-Parent")), /ENOENT/);

  await expectToolError(port, "vault_create_directory", {
    parent: "Projects",
    name: "No-Reason",
    reason: "   "
  }, /reason is required/i);
  await assert.rejects(() => stat(path.join(vault, "Projects", "No-Reason")), /ENOENT/);

  const createdUnderOther = await callTool(port, "vault_create_directory", {
    parent: "Other",
    name: "Agent-Created",
    reason: "The existing directories do not cover this independent category, so it belongs under Other."
  });
  assert.equal(createdUnderOther.path, "Other/Agent-Created");
  assert.equal((await stat(path.join(vault, createdUnderOther.path))).isDirectory(), true);

  await callTool(port, "vault_create_directory", {
    parent: "Other",
    name: "Portable-Name",
    reason: "This creates a portable directory name for conflict testing."
  });
  await expectToolError(port, "vault_create_directory", {
    parent: "Other",
    name: "portable-name",
    reason: "This case-only variant would collide on common Obsidian desktop platforms."
  }, /conflicts with existing path.*Portable-Name/i);

  const createdTopLevel = await callTool(port, "vault_create_directory", {
    parent: "",
    name: "New-Top-Level",
    reason: "No existing top-level category matches this durable area of knowledge."
  });
  assert.equal(createdTopLevel.path, "New-Top-Level");
  assert.equal((await stat(path.join(vault, createdTopLevel.path))).isDirectory(), true);
  await callTool(port, "vault_write", { path: "New-Top-Level/note.md", content: "top-level directory created explicitly\n" });
  assert.match(await readFile(path.join(vault, "New-Top-Level", "note.md"), "utf8"), /created explicitly/);

  await expectToolError(port, "vault_write", {
    path: "Projects/Unplanned/note.md",
    content: "must not create parent\n"
  }, /parent directory not found: Projects\/Unplanned.*never creates directories implicitly/i);
  await assert.rejects(() => stat(path.join(vault, "Projects", "Unplanned")), /ENOENT/);

  await expectToolError(port, "vault_append", {
    path: "Projects/Another-Unplanned/note.md",
    content: "must not create parent\n"
  }, /parent directory not found/i);
  await assert.rejects(() => stat(path.join(vault, "Projects", "Another-Unplanned")), /ENOENT/);

  await expectToolError(port, "vault_write", {
    path: "root-note.md",
    content: "root write\n"
  }, /writes to the vault root are not allowed/i);
  await assert.rejects(() => stat(path.join(vault, "root-note.md")), /ENOENT/);

  await callTool(port, "vault_write", {
    path: "Other/allowed.md",
    content: "existing directories are writable without a root allowlist\n"
  });
  assert.match(await readFile(path.join(vault, "Other", "allowed.md"), "utf8"), /without a root allowlist/);

  await callTool(port, "vault_write", {
    path: "Projects/move-policy-source.md",
    content: "move policy\n"
  });
  await expectToolError(port, "vault_move", {
    path: "Projects/move-policy-source.md",
    destination: "Projects/Missing-Destination/"
  }, /parent directory not found/i);
  assert.match(await readFile(path.join(vault, "Projects", "move-policy-source.md"), "utf8"), /move policy/);
  await assert.rejects(() => stat(path.join(vault, "Projects", "Missing-Destination")), /ENOENT/);

  await expectToolError(port, "vault_create_external_reference_note", {
    path: "Projects/Missing-References/reference.md",
    title: "Reference",
    references: [{ label: "source", location: "external://source" }]
  }, /parent directory not found/i);
  await assert.rejects(() => stat(path.join(vault, "Projects", "Missing-References")), /ENOENT/);
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

  const querySearch = await callTool(port, "search_query", {
    pathGlob: "98-Inbox/**",
    tag: "project/active",
    frontmatter: { priority: 42 },
    content: "needle"
  });
  assert(querySearch.some((item: any) => item.filename === "98-Inbox/fixture.md"));
  assert(querySearch.every((item: any) => item.filename.endsWith(".md")));

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
    assert(names.includes("vault_list_detailed"));
    assert(names.includes("search_simple"));
    assert(names.includes("search_query"));
    assert(names.includes("find_asset_references"));
    assert(names.includes("asset_audit"));
    assert(!names.includes("vault_write"));
    assert(!names.includes("vault_create_directory"));
    assert(!names.includes("vault_delete"));
    assert(!names.includes("vault_import_file"));
    assert(names.includes("vault_export_file"));
    assert(!names.includes("vault_create_external_reference_note"));
    const response = await rpc(readOnlyPort, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_write", arguments: { path: "98-Inbox/nope.md", content: "nope" } } });
    assert.equal(response.error?.code, -32602);
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

async function expectInvalidArguments(port: number, name: string, args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const response = await rpc(port, { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.error?.code, -32602, JSON.stringify(response));
  assert.equal(response.error?.data?.errorCode, "INVALID_ARGUMENT", JSON.stringify(response));
  assert.match(JSON.stringify(response.error?.data?.issues ?? []), pattern);
}

function unwrapStructuredContent(value: any): any {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && "result" in value) {
    return value.result;
  }
  return value;
}
