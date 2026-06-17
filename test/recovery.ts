import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, expectToolError } from "./helpers.js";

const auditRoot = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-audit-"));
const auditPath = path.join(auditRoot, "obsidian-vault-mcp.audit.log");
const server = await createVaultServer({
  TRASH_DELETE: "true",
  BACKUP_BEFORE_WRITE: "true",
  AUDIT_LOG_PATH: auditPath
});

try {
  await mkdir(path.join(server.vault, "Projects"), { recursive: true });
  await writeFile(path.join(server.vault, "Projects", "recover.md"), "# Recover\n\noriginal\n", "utf8");

  await callTool(server.port, "vault_write", { path: "Projects/recover.md", content: "# Recover\n\nwritten\n" });
  await assertBackupContains(/original/);

  await callTool(server.port, "vault_patch", {
    path: "Projects/recover.md",
    targetType: "heading",
    target: "Recover",
    operation: "append",
    content: "patched\n"
  });
  await assertBackupContains(/written/);

  await callTool(server.port, "vault_move", { path: "Projects/recover.md", destination: "Projects/moved.md" });
  await assertBackupContains(/patched/);

  await callTool(server.port, "vault_delete", { path: "Projects/moved.md" });
  await statFirstFile(path.join(server.vault, ".trash"));

  await expectToolError(server.port, "vault_read", { path: ".trash/whatever.md" }, /not allowed|traversal|only Markdown/i);
  await expectToolError(server.port, "vault_read", { path: ".backups/whatever.md" }, /not allowed|traversal|only Markdown/i);

  await expectToolError(server.port, "vault_patch", {
    path: "Projects/missing.md",
    targetType: "heading",
    target: "Nope",
    operation: "append",
    content: "fail\n"
  }, /no such file|ENOENT/i);

  const auditLines = (await readFile(auditPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(auditLines.some((line) => line.tool === "vault_write" && line.status === "success"));
  assert(auditLines.some((line) => line.tool === "vault_patch" && line.status === "success"));
  assert(auditLines.some((line) => line.tool === "vault_move" && line.status === "success"));
  assert(auditLines.some((line) => line.tool === "vault_delete" && line.status === "success" && typeof line.trashPath === "string"));
  assert(auditLines.some((line) => line.tool === "vault_patch" && line.status === "failure"));
  assert(auditLines.some((line) => line.tool === "vault_backup" && line.status === "success"));

  console.log("recovery ok");
} finally {
  await server.close();
  await rm(auditRoot, { recursive: true, force: true });
}

async function assertBackupContains(pattern: RegExp): Promise<void> {
  const files = await collectFiles(path.join(server.vault, ".backups"));
  assert(files.length > 0);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert(contents.some((content) => pattern.test(content)), `missing backup matching ${pattern}`);
}

async function statFirstFile(root: string): Promise<void> {
  const files = await collectFiles(root);
  assert(files.length > 0);
  await stat(files[0]!);
}

async function collectFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}
