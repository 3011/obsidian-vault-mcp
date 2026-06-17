import { writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, expectToolError } from "./helpers.js";

const server = await createVaultServer();

try {
  await writeFile(path.join(server.vault, "98-Inbox", "complex.md"), [
    "---",
    "title: \"A: complex title\"",
    "tags: [alpha, nested/tag]",
    "meta:",
    "  owner: \"测试\"",
    "  priority: 5",
    "---",
    "",
    "# 你好",
    "",
    "Unicode section.",
    "",
    "```",
    "# Not A Heading",
    "^not-a-block",
    "```",
    "",
    "# Table",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 | ^table-block",
    ""
  ].join("\n"), "utf8");

  const read = await callTool(server.port, "vault_read", { path: "98-Inbox/complex.md" });
  assert.equal(read.frontmatter.title, "A: complex title");
  assert.equal(read.frontmatter.meta.owner, "测试");
  assert(read.tags.includes("nested/tag"));

  const map = await callTool(server.port, "vault_get_document_map", { path: "98-Inbox/complex.md" });
  assert(map.headings.includes("你好"));
  assert(map.headings.includes("Table"));
  assert(!map.headings.includes("Not A Heading"));
  assert(map.blocks.includes("table-block"));
  assert(!map.blocks.includes("not-a-block"));

  await callTool(server.port, "vault_patch", {
    path: "98-Inbox/complex.md",
    targetType: "heading",
    target: "你好",
    operation: "append",
    content: "追加内容\n",
    rejectIfContentPreexists: true
  });
  await expectToolError(server.port, "vault_patch", {
    path: "98-Inbox/complex.md",
    targetType: "heading",
    target: "你好",
    operation: "append",
    content: "追加内容\n",
    rejectIfContentPreexists: true
  }, /already|preexists/i);

  await callTool(server.port, "vault_patch", {
    path: "98-Inbox/complex.md",
    targetType: "block",
    target: "table-block",
    operation: "append",
    contentType: "application/json",
    content: [["3", "4"]]
  });
  const afterTable = await callTool(server.port, "vault_read", { path: "98-Inbox/complex.md" });
  assert.match(afterTable.content, /\| 3 \| 4 \|/);

  await writeFile(path.join(server.vault, "98-Inbox", "crlf.md"), "# CRLF\r\n\r\nbody\r\n", "utf8");
  await callTool(server.port, "vault_patch", {
    path: "98-Inbox/crlf.md",
    targetType: "heading",
    target: "CRLF",
    operation: "append",
    content: "next\r\n"
  });
  const crlf = await callTool(server.port, "vault_read", { path: "98-Inbox/crlf.md" });
  assert.match(crlf.content, /next\r?\n/);

  console.log("markdown yaml ok");
} finally {
  await server.close();
}
