import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, expectToolError, rpc } from "./helpers.js";

const png = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = b64([0xff, 0xd8, 0xff, 0x00]);
const webp = b64([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const gif = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const pdf = Buffer.from("%PDF-1.7").toString("base64");

const server = await createVaultServer({ MAX_IMAGE_ASSET_BYTES: "32" });

try {
  await testToolDiscovery();
  await testUploadImages();
  await testCreateNoteWithAssets();
  await testExternalReferenceNote();
  await testRejectedAssets();
  console.log("assets ok");
} finally {
  await server.close();
}

async function testToolDiscovery(): Promise<void> {
  const tools = await rpc(server.port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = tools.result.tools.map((tool: any) => tool.name);
  assert(names.includes("vault_upload_image_asset"));
  assert(names.includes("vault_create_note_with_assets"));
  assert(names.includes("vault_create_external_reference_note"));
}

async function testUploadImages(): Promise<void> {
  for (const image of [
    { filename: "one.png", mimeType: "image/png", contentBase64: png, ext: ".png" },
    { filename: "two.jpg", mimeType: "image/jpeg", contentBase64: jpeg, ext: ".jpg" },
    { filename: "three.webp", mimeType: "image/webp", contentBase64: webp, ext: ".webp" },
    { filename: "four.gif", mimeType: "image/gif", contentBase64: gif, ext: ".gif" }
  ]) {
    const result = await callTool(server.port, "vault_upload_image_asset", {
      filename: image.filename,
      mimeType: image.mimeType,
      contentBase64: image.contentBase64
    });
    assert(result.path.startsWith("98-Inbox/assets/"));
    assert(result.path.endsWith(image.ext));
    assert(result.embed.includes(result.path));
    assert.equal(result.mimeType, image.mimeType);
    assert.equal(result.bytes, Buffer.from(image.contentBase64, "base64").length);
    assert.equal(result.sha256.length, 64);
    await stat(path.join(server.vault, result.path));
  }

  const duplicate = await callTool(server.port, "vault_upload_image_asset", {
    filename: "one.png",
    mimeType: "image/png",
    contentBase64: png
  });
  assert.match(duplicate.path, /^98-Inbox\/assets\/one-[a-f0-9]{12}\.png$/);
}

async function testCreateNoteWithAssets(): Promise<void> {
  const result = await callTool(server.port, "vault_create_note_with_assets", {
    path: "Projects/with-assets.md",
    content: "# Screenshot\n\n{{asset:0}}\n\nBody\n",
    assets: [
      { filename: "screen.png", mimeType: "image/png", contentBase64: png },
      { filename: "extra.gif", mimeType: "image/gif", contentBase64: gif }
    ]
  });
  assert.equal(result.path, "Projects/with-assets.md");
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[0].path, "Projects/assets/screen.png");
  assert.equal(result.assets[1].path, "Projects/assets/extra.gif");
  const note = await readFile(path.join(server.vault, "Projects", "with-assets.md"), "utf8");
  assert.match(note, /!\[\[Projects\/assets\/screen\.png]]/);
  assert.match(note, /## Assets/);
  assert.match(note, /!\[\[Projects\/assets\/extra\.gif]]/);
  await stat(path.join(server.vault, "Projects", "assets", "screen.png"));
  await stat(path.join(server.vault, "Projects", "assets", "extra.gif"));
}

async function testExternalReferenceNote(): Promise<void> {
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
}

async function testRejectedAssets(): Promise<void> {
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.pdf",
    mimeType: "application/pdf",
    contentBase64: pdf
  }, /MIME type is not allowed/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.png",
    mimeType: "image/png",
    contentBase64: pdf
  }, /does not match MIME/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.pdf",
    mimeType: "image/png",
    contentBase64: png
  }, /extension does not match/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.png",
    mimeType: "image/png",
    contentBase64: b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0x00)])
  }, /exceeds maximum size/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.png",
    mimeType: "image/png",
    contentBase64: png,
    dir: "98-Inbox"
  }, /assets.*directory/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.png",
    mimeType: "image/png",
    contentBase64: png,
    dir: "../assets"
  }, /traversal/i);
  await expectToolError(server.port, "vault_upload_image_asset", {
    filename: "bad.png",
    mimeType: "image/png",
    contentBase64: png,
    dir: ".obsidian/assets"
  }, /not allowed/i);
  await expectToolError(server.port, "vault_create_note_with_assets", {
    path: "98-Inbox/bad-placeholder.md",
    content: "{{asset:1}}",
    assets: [{ filename: "ok.png", mimeType: "image/png", contentBase64: png }]
  }, /out of range/i);
}

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}
