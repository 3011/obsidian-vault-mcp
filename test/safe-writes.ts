import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, rpc } from "./helpers.js";
import { ToolDomainError } from "../src/mcp/errors.js";
import { FsVault } from "../src/vault/FsVault.js";

const server = await createVaultServer({ BACKUP_BEFORE_WRITE: "false" });
try {
  await assertStrictInputValidation();
  await assertRawByteRevision();
  await assertCreateReplaceAndConflicts();
  await assertAppendAndPatchConflicts();
  await assertDeleteConflict();
  await assertAtomicOverwriteMove();
  console.log("safe writes ok");
} finally {
  await server.close();
}

await assertCrossInstanceCreateOnly();

async function assertStrictInputValidation(): Promise<void> {
  await writeFile(path.join(server.vault, "98-Inbox", "validation-source.md"), "source\n", "utf8");
  const response = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "vault_move",
      arguments: {
        path: "98-Inbox/validation-source.md",
        destination: "98-Inbox/validation-destination.md",
        allowOverwrite: "false"
      }
    }
  });
  assert.equal(response.error?.code, -32602, JSON.stringify(response));
  assert.equal(response.error?.data?.errorCode, "INVALID_ARGUMENT");
  assert.equal(await readFile(path.join(server.vault, "98-Inbox", "validation-source.md"), "utf8"), "source\n");
  await assert.rejects(() => stat(path.join(server.vault, "98-Inbox", "validation-destination.md")), /ENOENT/);

  const additional = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "vault_write", arguments: { path: "98-Inbox/no-extra.md", content: "x", extra: true } }
  });
  assert.equal(additional.error?.code, -32602, JSON.stringify(additional));

  const unknown = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "vault_does_not_exist", arguments: {} }
  });
  assert.equal(unknown.error?.code, -32602, JSON.stringify(unknown));
}

async function assertRawByteRevision(): Promise<void> {
  const bytes = Buffer.from("line-one\r\nline-two\r\n", "utf8");
  const file = path.join(server.vault, "98-Inbox", "raw-revision.md");
  await writeFile(file, bytes);
  const read = await callTool(server.port, "vault_read", { path: "98-Inbox/raw-revision.md" });
  assert.equal(read.revision.sha256, sha256(bytes));
  assert.equal(read.revision.size, bytes.length);
  assert.equal(typeof read.revision.mtimeMs, "number");
}

async function assertCreateReplaceAndConflicts(): Promise<void> {
  const created = await callTool(server.port, "vault_create_note", {
    path: "98-Inbox/create-only.md",
    content: "first\r\n"
  });
  assert.equal(created.path, "98-Inbox/create-only.md");
  assert.equal(created.revision.sha256, sha256(Buffer.from("first\r\n")));

  await expectDomainError("vault_create_note", {
    path: "98-Inbox/create-only.md",
    content: "must not overwrite\n"
  }, "ALREADY_EXISTS");
  assert.equal(await readFile(path.join(server.vault, "98-Inbox", "create-only.md"), "utf8"), "first\r\n");

  const read = await callTool(server.port, "vault_read", { path: "98-Inbox/create-only.md" });
  await writeFile(path.join(server.vault, "98-Inbox", "create-only.md"), "external change\n", "utf8");
  await expectDomainError("vault_replace_note", {
    path: "98-Inbox/create-only.md",
    content: "stale replacement\n",
    expectedSha256: read.revision.sha256
  }, "CONTENT_CONFLICT");
  assert.equal(await readFile(path.join(server.vault, "98-Inbox", "create-only.md"), "utf8"), "external change\n");

  const current = await callTool(server.port, "vault_read", { path: "98-Inbox/create-only.md" });
  const replaced = await callTool(server.port, "vault_replace_note", {
    path: "98-Inbox/create-only.md",
    content: "safe replacement\n",
    expectedSha256: current.revision.sha256
  });
  assert.equal(replaced.revision.sha256, sha256(Buffer.from("safe replacement\n")));
}

async function assertAppendAndPatchConflicts(): Promise<void> {
  await callTool(server.port, "vault_create_note", { path: "98-Inbox/mutate.md", content: "# H\n\nbase\n" });
  const beforeAppend = await callTool(server.port, "vault_read", { path: "98-Inbox/mutate.md" });
  const appended = await callTool(server.port, "vault_append", {
    path: "98-Inbox/mutate.md",
    content: "append\n",
    expectedSha256: beforeAppend.revision.sha256
  });
  assert.notEqual(appended.revision.sha256, beforeAppend.revision.sha256);
  await expectDomainError("vault_append", {
    path: "98-Inbox/mutate.md",
    content: "duplicate\n",
    expectedSha256: beforeAppend.revision.sha256
  }, "CONTENT_CONFLICT");
  assert.doesNotMatch(await readFile(path.join(server.vault, "98-Inbox", "mutate.md"), "utf8"), /duplicate/);

  const beforePatch = await callTool(server.port, "vault_read", { path: "98-Inbox/mutate.md" });
  await writeFile(path.join(server.vault, "98-Inbox", "mutate.md"), "# H\n\nexternal\n", "utf8");
  await expectDomainError("vault_patch", {
    path: "98-Inbox/mutate.md",
    targetType: "heading",
    target: "H",
    operation: "replace",
    content: "patched",
    expectedSha256: beforePatch.revision.sha256
  }, "CONTENT_CONFLICT");
}

async function assertDeleteConflict(): Promise<void> {
  await writeFile(path.join(server.vault, "98-Inbox", "delete-conflict.md"), "delete me\n", "utf8");
  const read = await callTool(server.port, "vault_read", { path: "98-Inbox/delete-conflict.md" });
  await writeFile(path.join(server.vault, "98-Inbox", "delete-conflict.md"), "changed first\n", "utf8");
  await expectDomainError("vault_delete", {
    path: "98-Inbox/delete-conflict.md",
    expectedSha256: read.revision.sha256
  }, "CONTENT_CONFLICT");
  assert.equal(await readFile(path.join(server.vault, "98-Inbox", "delete-conflict.md"), "utf8"), "changed first\n");
}

async function assertAtomicOverwriteMove(): Promise<void> {
  const sourcePath = path.join(server.vault, "98-Inbox", "move-source.md");
  const destinationPath = path.join(server.vault, "98-Inbox", "move-destination.md");
  await writeFile(sourcePath, "new destination\n", "utf8");
  await writeFile(destinationPath, "old destination\n", "utf8");
  const source = await callTool(server.port, "vault_read", { path: "98-Inbox/move-source.md" });
  const destination = await callTool(server.port, "vault_read", { path: "98-Inbox/move-destination.md" });
  await callTool(server.port, "vault_move", {
    path: "98-Inbox/move-source.md",
    destination: "98-Inbox/move-destination.md",
    allowOverwrite: true,
    expectedSha256: source.revision.sha256,
    expectedDestinationSha256: destination.revision.sha256
  });
  assert.equal(await readFile(destinationPath, "utf8"), "new destination\n");
  await assert.rejects(() => stat(sourcePath), /ENOENT/);

  await writeFile(sourcePath, "second source\n", "utf8");
  const secondSource = await callTool(server.port, "vault_read", { path: "98-Inbox/move-source.md" });
  await expectDomainError("vault_move", {
    path: "98-Inbox/move-source.md",
    destination: "98-Inbox/move-destination.md",
    allowOverwrite: true,
    expectedSha256: secondSource.revision.sha256,
    expectedDestinationSha256: "0".repeat(64)
  }, "DESTINATION_CONFLICT");
  assert.equal(await readFile(sourcePath, "utf8"), "second source\n");
  assert.equal(await readFile(destinationPath, "utf8"), "new destination\n");

  const sourceCode = await readFile(path.resolve(import.meta.dirname, "../../src/vault/FsVault.ts"), "utf8");
  assert(!sourceCode.includes("rm(destinationAbsolute"), "overwrite move must not delete destination before rename");
}

async function assertCrossInstanceCreateOnly(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-create-only-"));
  try {
    await mkdir(path.join(root, "Notes"), { recursive: true });
    const first = new FsVault(root, "Notes", { backupBeforeWrite: false });
    const second = new FsVault(root, "Notes", { backupBeforeWrite: false });
    await Promise.all([first.init(), second.init()]);
    const results = await Promise.allSettled([
      first.createNote("Notes/race.md", "first\n"),
      second.createNote("Notes/race.md", "second\n")
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert(rejected);
    assert(rejected.reason instanceof ToolDomainError);
    assert.equal(rejected.reason.code, "ALREADY_EXISTS");
    assert(["first\n", "second\n"].includes(await readFile(path.join(root, "Notes", "race.md"), "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectDomainError(name: string, args: Record<string, unknown>, code: string): Promise<void> {
  const response = await rpc(server.port, {
    jsonrpc: "2.0",
    id: Math.random(),
    method: "tools/call",
    params: { name, arguments: args }
  });
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  assert.equal(response.result?.structuredContent?.error?.code, code, JSON.stringify(response));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
