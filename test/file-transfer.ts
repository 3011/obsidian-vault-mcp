import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, expectToolError, rpc } from "./helpers.js";

const payloads: Record<string, Buffer> = {
  "/sample.pdf": Buffer.from("%PDF-1.7\nobsidian-file-transfer\n", "utf8"),
  "/replacement.pdf": Buffer.from("%PDF-1.7\nreplacement-content\n", "utf8"),
  "/package.rpm": Buffer.from([0xed, 0xab, 0xee, 0xdb, 0x01, 0x02, 0x03, 0x04]),
  "/too-large.bin": Buffer.alloc(128, 0x5a)
};

const sourceServer = createServer((req, res) => {
  const payload = payloads[req.url || ""];
  if (!payload) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": req.url?.endsWith(".pdf") ? "application/pdf" : "application/octet-stream", "content-length": String(payload.length) });
  res.end(payload);
});
await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
const address = sourceServer.address();
if (!address || typeof address === "string") throw new Error("source server did not bind TCP port");
const sourceBase = `http://127.0.0.1:${address.port}`;

const server = await createVaultServer({
  FILE_IMPORT_ALLOW_HTTP: "true",
  FILE_IMPORT_ALLOWED_HOSTS: "127.0.0.1",
  MAX_FILE_TRANSFER_BYTES: "1048576",
  MAX_EMBEDDED_EXPORT_BYTES: "1048576"
});
await mkdir(path.join(server.vault, "Projects"), { recursive: true });

try {
  await testDiscovery();
  await testImportAndIntegrity();
  await testOverwriteProtection();
  await testGenericFileType();
  await testExport();
  await testSecurityBoundaries();
  await testSizeLimit();
  console.log("file transfer ok");
} finally {
  sourceServer.close();
  await server.close();
}

async function testDiscovery(): Promise<void> {
  const tools = await rpc(server.port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const names = tools.result.tools.map((tool: any) => tool.name);
  assert(names.includes("vault_import_file"));
  assert(names.includes("vault_export_file"));
  assert(!names.includes("vault_upload_image_asset"));
  assert(!names.includes("vault_create_note_with_assets"));

  const imported = tools.result.tools.find((tool: any) => tool.name === "vault_import_file");
  assert.deepEqual(imported._meta?.["openai/fileParams"], ["file"]);
  assert.equal(imported.inputSchema.properties.file.$ref, "#/$defs/OpenAIFile");
  assert.equal(imported.inputSchema.properties.destination.type, "string");

  const exported = tools.result.tools.find((tool: any) => tool.name === "vault_export_file");
  assert.equal(exported.outputSchema.properties.deliveryMode.const, "embedded_resource");
}

async function testImportAndIntegrity(): Promise<void> {
  const source = payloads["/sample.pdf"]!;
  const expectedSha256 = sha256(source);
  const result = await callTool(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/sample.pdf`, "source-pdf", "sample.pdf", "application/pdf"),
    destination: "Projects/sample.pdf",
    expectedSha256,
    expectedSize: source.length
  });
  assert.equal(result.path, "Projects/sample.pdf");
  assert.equal(result.bytes, source.length);
  assert.equal(result.sha256, expectedSha256);
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.verified, true);
  assert.equal(result.created, true);
  assert.equal(result.overwritten, false);
  assert.equal(result.idempotent, false);
  assert.equal(result.obsidian.link, "[[Projects/sample.pdf]]");
  assert.equal(result.obsidian.embed, "![[Projects/sample.pdf]]");
  assert.deepEqual(await readFile(path.join(server.vault, "Projects", "sample.pdf")), source);

  const retry = await callTool(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/sample.pdf`, "source-pdf-retry", "sample.pdf", "application/pdf"),
    destination: "Projects/sample.pdf",
    expectedSha256,
    expectedSize: source.length
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.created, false);
  assert.equal(retry.overwritten, false);

  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/sample.pdf`, "bad-hash", "sample.pdf", "application/pdf"),
    destination: "Projects/bad-hash.pdf",
    expectedSha256: "0".repeat(64)
  }, /sha256 does not match/i);
  await assert.rejects(() => stat(path.join(server.vault, "Projects", "bad-hash.pdf")), /ENOENT/);
}

async function testOverwriteProtection(): Promise<void> {
  const target = path.join(server.vault, "Projects", "replace.pdf");
  const original = Buffer.from("original-content", "utf8");
  await writeFile(target, original);
  const replacement = payloads["/replacement.pdf"]!;

  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/replacement.pdf`, "replace-no", "replacement.pdf", "application/pdf"),
    destination: "Projects/replace.pdf"
  }, /already exists with different content/i);

  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/replacement.pdf`, "replace-no-revision", "replacement.pdf", "application/pdf"),
    destination: "Projects/replace.pdf",
    allowOverwrite: true
  }, /expectedDestinationSha256 is required/i);

  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/replacement.pdf`, "replace-wrong-revision", "replacement.pdf", "application/pdf"),
    destination: "Projects/replace.pdf",
    allowOverwrite: true,
    expectedDestinationSha256: "0".repeat(64)
  }, /destination revision does not match/i);

  const result = await callTool(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/replacement.pdf`, "replace-ok", "replacement.pdf", "application/pdf"),
    destination: "Projects/replace.pdf",
    allowOverwrite: true,
    expectedDestinationSha256: sha256(original),
    expectedSha256: sha256(replacement),
    expectedSize: replacement.length
  });
  assert.equal(result.overwritten, true);
  assert.equal(result.created, false);
  assert.deepEqual(await readFile(target), replacement);
}

async function testGenericFileType(): Promise<void> {
  const source = payloads["/package.rpm"]!;
  const result = await callTool(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/package.rpm`, "source-rpm", "package.rpm", "application/x-rpm"),
    destination: "Projects/package.rpm",
    expectedSha256: sha256(source),
    expectedSize: source.length
  });
  assert.equal(result.mimeType, "application/x-rpm");
  assert.deepEqual(await readFile(path.join(server.vault, "Projects", "package.rpm")), source);
}

async function testExport(): Promise<void> {
  const source = Buffer.from([0, 1, 2, 3, 4, 5, 250, 251, 252, 253, 254, 255]);
  await writeFile(path.join(server.vault, "Projects", "binary.bin"), source);
  const response = await rpc(server.port, {
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: { name: "vault_export_file", arguments: { path: "Projects/binary.bin" } }
  });
  assert.equal(response.result.isError, false, JSON.stringify(response));
  assert.equal(response.result.structuredContent.path, "Projects/binary.bin");
  assert.equal(response.result.structuredContent.bytes, source.length);
  assert.equal(response.result.structuredContent.sha256, sha256(source));
  assert.equal(response.result.structuredContent.embedded, true);
  assert.equal(response.result.structuredContent.deliveryMode, "embedded_resource");
  assert.equal(response.result.content[1].type, "resource");
  assert.equal(response.result.content[1].resource.mimeType, "application/octet-stream");
  assert.deepEqual(Buffer.from(response.result.content[1].resource.blob, "base64"), source);

  await expectToolError(server.port, "vault_export_file", { path: "Projects/binary.bin", maxBytes: 4 }, /file_too_large/i);
}

async function testSecurityBoundaries(): Promise<void> {
  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/sample.pdf`, "bad-path", "sample.pdf", "application/pdf"),
    destination: "../escape.pdf"
  }, /traversal/i);

  await expectToolError(server.port, "vault_import_file", {
    file: fileRef(`${sourceBase}/sample.pdf`, "missing-parent", "sample.pdf", "application/pdf"),
    destination: "Missing/sample.pdf"
  }, /parent directory not found/i);

  const outside = path.join(server.root, "outside.bin");
  await writeFile(outside, Buffer.from("outside"));
  await symlink(outside, path.join(server.vault, "Projects", "link.bin"));
  await expectToolError(server.port, "vault_export_file", { path: "Projects/link.bin" }, /regular file/i);
}

async function testSizeLimit(): Promise<void> {
  const limited = await createVaultServer({
    FILE_IMPORT_ALLOW_HTTP: "true",
    FILE_IMPORT_ALLOWED_HOSTS: "127.0.0.1",
    MAX_FILE_TRANSFER_BYTES: "32"
  });
  try {
    await expectToolError(limited.port, "vault_import_file", {
      file: fileRef(`${sourceBase}/too-large.bin`, "too-large", "too-large.bin", "application/octet-stream"),
      destination: "98-Inbox/too-large.bin"
    }, /file_too_large/i);
  } finally {
    await limited.close();
  }
}

function fileRef(download_url: string, file_id: string, file_name: string, mime_type: string): Record<string, string> {
  return { download_url, file_id, file_name, mime_type };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
