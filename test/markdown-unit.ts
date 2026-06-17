import assert from "node:assert/strict";
import { parseFrontmatter } from "../src/markdown/frontmatter.js";
import { getDocumentMap } from "../src/markdown/documentMap.js";
import { patchMarkdown } from "../src/markdown/patch.js";

const complex = `---
title: Complex
tags:
  - alpha/beta
meta:
  owner: chatgpt
  flags:
    - one
    - two
---
# Alpha

## Unicode 标题

| a | b |
|---|---|
| 1 | 2 | ^table-block

\`\`\`md
# Not a heading
^not-a-block
#tag-in-code
\`\`\`

Real block ^real-block
`;

const frontmatter = parseFrontmatter(complex);
assert.equal(frontmatter.data.title, "Complex");
assert.equal((frontmatter.data.meta as Record<string, unknown>).owner, "chatgpt");
assert.deepEqual(frontmatter.data.tags, ["alpha/beta"]);

const map = getDocumentMap(complex);
assert(map.headings.includes("Alpha"));
assert(map.headings.includes("Alpha::Unicode 标题"));
assert(!map.headings.some((heading) => heading.includes("Not a heading")));
assert(map.blocks.includes("real-block"));
assert(map.blocks.includes("table-block"));
assert(!map.blocks.includes("not-a-block"));
assert(map.tags.includes("alpha/beta"));
assert(!map.tags.includes("tag-in-code"));

const patchedHeading = patchMarkdown(complex, {
  targetType: "heading",
  target: "Alpha::Unicode 标题",
  operation: "append",
  content: "\n追加内容",
  createTargetIfMissing: false,
  trimTargetWhitespace: false,
  rejectIfContentPreexists: true
});
assert.match(patchedHeading, /追加内容/);

const patchedTable = patchMarkdown(complex, {
  targetType: "block",
  target: "table-block",
  operation: "append",
  contentType: "application/json",
  content: [["3", "4"]],
  createTargetIfMissing: false,
  trimTargetWhitespace: false,
  rejectIfContentPreexists: false
});
assert.match(patchedTable, /\| 3 \| 4 \|/);

const duplicate = "# Dup\n\nfirst\n\n# Dup\n\nsecond\n";
const duplicateMap = getDocumentMap(duplicate);
const duplicateHeading = duplicateMap.headingDetails.find((heading) => heading.path === "Dup");
assert.equal(duplicateHeading?.line, 5);
const patchedDuplicate = patchMarkdown(duplicate, {
  targetType: "heading",
  target: "Dup",
  operation: "append",
  content: "patched\n"
});
assert.match(patchedDuplicate, /first\n\n# Dup\n\nsecond\npatched\n/);

console.log("markdown unit ok");
