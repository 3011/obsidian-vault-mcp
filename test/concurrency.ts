import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer } from "./helpers.js";

const server = await createVaultServer();

try {
  await callTool(server.port, "vault_write", { path: "98-Inbox/concurrent.md", content: "# Concurrent\n\n" });
  const writes = Array.from({ length: 30 }, (_, index) =>
    callTool(server.port, "vault_append", {
      path: "98-Inbox/concurrent.md",
      content: `line-${index}\n`
    })
  );
  await Promise.all(writes);

  const content = await readFile(path.join(server.vault, "98-Inbox", "concurrent.md"), "utf8");
  for (let index = 0; index < 30; index += 1) {
    assert.match(content, new RegExp(`line-${index}`));
  }
  assert.equal((content.match(/line-/g) ?? []).length, 30);
  console.log("concurrency ok");
} finally {
  await server.close();
}
