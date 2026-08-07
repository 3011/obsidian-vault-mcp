import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer } from "./helpers.js";

const server = await createVaultServer();
try {
  const result = await callTool(server.port, "vault_create_external_reference_note", {
    path: "98-Inbox/external-reference.md",
    title: "客户 Jenkins 构建失败排查",
    references: [
      { label: "原始日志包", location: "NAS:/worklogs/2026/customer-a/logs.zip", type: "log_bundle", note: "不进入 Obsidian" }
    ],
    summary: "构建初始化阶段失败。",
    keyFindings: ["uv_thread_create failed", "seccomp clone3 compatibility issue"],
    nextActions: ["检查 Docker/containerd 版本", "检查 seccomp profile"]
  });
  assert.equal(result.path, "98-Inbox/external-reference.md");
  const note = await readFile(path.join(server.vault, result.path), "utf8");
  assert.match(note, /type: external-reference-note/);
  assert.match(note, /NAS:\/worklogs\/2026\/customer-a\/logs\.zip/);
  assert.match(note, /uv_thread_create failed/);
  assert.match(note, /检查 seccomp profile/);
  console.log("external reference ok");
} finally {
  await server.close();
}
