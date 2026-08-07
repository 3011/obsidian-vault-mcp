import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { config, type Config } from "../config.js";
import { FsVault } from "../vault/FsVault.js";
import { ToolDomainError } from "./errors.js";

export type OpenAIFileReference = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

export type ImportedFileTransferResult = {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  sourceFileId: string;
  sourceFileName: string;
  verified: true;
  created: boolean;
  overwritten: boolean;
  idempotent: boolean;
  obsidian: { link: string; embed: string };
};

export type ExportedFileTransferResult = {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  fileName: string;
  embedded: true;
  deliveryMode: "embedded_resource";
};

export type EmbeddedFileExport = {
  result: ExportedFileTransferResult;
  resource: {
    uri: string;
    mimeType: string;
    blob: string;
  };
};

export class VaultFileTransferManager {
  private activeTransfers = 0;

  constructor(private readonly vault: FsVault, private readonly cfg: Config = config) {}

  async importFile(args: Record<string, unknown>): Promise<ImportedFileTransferResult> {
    return this.withTransferSlot(async () => {
      const file = requireOpenAIFile(args.file);
      const destination = requireString(args.destination, "destination");
      const expectedSha256 = optionalSha256(args.expectedSha256, "expectedSha256");
      const expectedSize = optionalPositiveInteger(args.expectedSize, "expectedSize");
      const allowOverwrite = args.allowOverwrite === true;
      const expectedDestinationSha256 = optionalSha256(args.expectedDestinationSha256, "expectedDestinationSha256");
      const sourceUrl = validateImportUrl(file.download_url, this.cfg);
      const temp = await this.allocateTempPath("import");
      const guard = createTransferGuard(this.cfg.fileTransferTimeoutSeconds);

      try {
        const response = await fetchFollowingRedirects(sourceUrl, this.cfg, guard.signal);
        if (!response.ok || !response.body) {
          throw new ToolDomainError("SOURCE_DOWNLOAD_FAILED", `source download failed: HTTP ${response.status}`, {
            details: { status: response.status }
          });
        }
        const declaredLength = parseContentLength(response.headers.get("content-length"));
        if (declaredLength !== null && declaredLength > this.cfg.maxFileTransferBytes) {
          throw fileTooLarge(declaredLength, this.cfg.maxFileTransferBytes);
        }
        if (expectedSize !== null && declaredLength !== null && declaredLength !== expectedSize) {
          throw new ToolDomainError("CHECKSUM_MISMATCH", `size does not match: expected ${expectedSize}, got ${declaredLength}`, {
            details: { expectedSize, actualSize: declaredLength }
          });
        }

        const downloaded = await writeHttpBodyToFile(
          response.body as unknown as AsyncIterable<Uint8Array>,
          temp.tmpPath,
          this.cfg.maxFileTransferBytes,
          guard.signal
        );
        if (expectedSize !== null && downloaded.bytes !== expectedSize) {
          throw new ToolDomainError("CHECKSUM_MISMATCH", `size does not match: expected ${expectedSize}, got ${downloaded.bytes}`, {
            details: { expectedSize, actualSize: downloaded.bytes }
          });
        }
        if (expectedSha256 && downloaded.sha256 !== expectedSha256) {
          throw new ToolDomainError("CHECKSUM_MISMATCH", `sha256 does not match: expected ${expectedSha256}, got ${downloaded.sha256}`, {
            details: { expectedSha256, actualSha256: downloaded.sha256 }
          });
        }

        const imported = await this.vault.importFileFromPath(destination, temp.tmpPath, { sha256: downloaded.sha256, size: downloaded.bytes }, {
          allowOverwrite,
          ...(expectedDestinationSha256 ? { expectedDestinationSha256 } : {})
        });
        return {
          path: imported.path,
          bytes: imported.revision.size,
          sha256: imported.revision.sha256,
          mimeType: normalizeMimeType(file.mime_type) || normalizeMimeType(response.headers.get("content-type")) || detectMimeType(file.file_name || imported.path),
          sourceFileId: file.file_id,
          sourceFileName: file.file_name || safeFileName(path.posix.basename(imported.path)),
          verified: true,
          created: imported.created,
          overwritten: imported.overwritten,
          idempotent: imported.idempotent,
          obsidian: imported.obsidian
        };
      } catch (error) {
        throw guard.mapError(error);
      } finally {
        guard.close();
        await rm(temp.dir, { recursive: true, force: true });
      }
    });
  }

  async exportFile(args: Record<string, unknown>): Promise<EmbeddedFileExport> {
    return this.withTransferSlot(async () => {
      const sourcePath = requireString(args.path, "path");
      const maxBytes = clampMaxBytes(args.maxBytes, this.cfg.maxEmbeddedExportBytes);
      const requestedName = typeof args.fileName === "string" && args.fileName.trim() ? safeFileName(args.fileName) : "";
      const exported = await this.vault.exportFile(sourcePath, maxBytes);
      const fileName = requestedName || safeFileName(path.posix.basename(exported.path));
      const mimeType = detectMimeType(fileName);
      const result: ExportedFileTransferResult = {
        path: exported.path,
        bytes: exported.revision.size,
        sha256: exported.revision.sha256,
        mimeType,
        fileName,
        embedded: true,
        deliveryMode: "embedded_resource"
      };
      return {
        result,
        resource: {
          uri: `https://obsidian-vault-mcp.invalid/embedded/${exported.revision.sha256}/${encodeURIComponent(fileName)}`,
          mimeType,
          blob: exported.bytes.toString("base64")
        }
      };
    });
  }

  private async withTransferSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeTransfers >= 2) {
      throw new ToolDomainError("TOO_MANY_ACTIVE_TRANSFERS", `too many active file transfers: ${this.activeTransfers}/2`, { retryable: true });
    }
    this.activeTransfers += 1;
    try {
      return await operation();
    } finally {
      this.activeTransfers -= 1;
    }
  }

  private async allocateTempPath(prefix: string): Promise<{ dir: string; tmpPath: string }> {
    await mkdir(this.cfg.fileTransferSpoolDir, { recursive: true });
    const dir = path.join(this.cfg.fileTransferSpoolDir, `.${prefix}-${randomBytes(16).toString("hex")}`);
    await mkdir(dir, { mode: 0o700 });
    return { dir, tmpPath: path.join(dir, "payload") };
  }
}

export function openAIFileSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Host-authorized temporary file reference. ChatGPT supplies this object through openai/fileParams.",
    properties: {
      download_url: { type: "string", description: "Temporary HTTPS download URL supplied and authorized by the host." },
      file_id: { type: "string", description: "Host file identifier." },
      mime_type: { type: "string", description: "Optional source MIME type supplied by the host." },
      file_name: { type: "string", description: "Optional original file name supplied by the host." }
    },
    required: ["download_url", "file_id"],
    additionalProperties: false
  };
}

function requireOpenAIFile(value: unknown): OpenAIFileReference {
  if (!isRecord(value)) throw new ToolDomainError("INVALID_ARGUMENT", "file must be a host file reference");
  const downloadUrl = typeof value.download_url === "string" ? value.download_url.trim() : "";
  const fileId = typeof value.file_id === "string" ? value.file_id.trim() : "";
  if (!downloadUrl || !fileId) throw new ToolDomainError("INVALID_ARGUMENT", "file.download_url and file.file_id are required");
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(typeof value.mime_type === "string" && value.mime_type.trim() ? { mime_type: value.mime_type.trim() } : {}),
    ...(typeof value.file_name === "string" && value.file_name.trim() ? { file_name: safeFileName(value.file_name) } : {})
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolDomainError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  return value.trim();
}

function optionalSha256(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const hash = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new ToolDomainError("INVALID_ARGUMENT", `${field} must contain 64 hexadecimal characters`);
  return hash;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ToolDomainError("INVALID_ARGUMENT", `${field} must be a non-negative integer`);
  return parsed;
}

function validateImportUrl(input: string, cfg: Config): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ToolDomainError("INVALID_ARGUMENT", "file.download_url must be an absolute URL");
  }
  if (url.username || url.password) throw new ToolDomainError("INVALID_ARGUMENT", "credentials in download URL are not allowed");
  if (url.protocol !== "https:" && !(cfg.fileImportAllowHttp && url.protocol === "http:")) {
    throw new ToolDomainError("INVALID_ARGUMENT", "file.download_url must use HTTPS");
  }
  if (!hostAllowed(url.hostname, cfg.fileImportAllowedHosts)) {
    throw new ToolDomainError("INVALID_ARGUMENT", `download host is not allowed: ${url.hostname}`, {
      details: { downloadHost: url.hostname.toLowerCase() }
    });
  }
  return url;
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowed.some((rule) => {
    const normalized = rule.toLowerCase().replace(/^\*\./, ".");
    return normalized.startsWith(".") ? host.endsWith(normalized) || host === normalized.slice(1) : host === normalized;
  });
}

async function fetchFollowingRedirects(initial: URL, cfg: Config, signal: AbortSignal): Promise<Response> {
  let current = initial;
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(current, { redirect: "manual", signal, headers: { accept: "*/*" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new ToolDomainError("SOURCE_DOWNLOAD_FAILED", "source returned a redirect without Location");
      current = validateImportUrl(new URL(location, current).toString(), cfg);
    }
    throw new ToolDomainError("SOURCE_DOWNLOAD_FAILED", "source download exceeded 5 redirects");
  } catch (error) {
    if (error instanceof ToolDomainError) throw error;
    throw new ToolDomainError("SOURCE_DOWNLOAD_FAILED", `source download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeHttpBodyToFile(
  body: AsyncIterable<Uint8Array>,
  filePath: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(filePath, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw new ToolDomainError("TRANSFER_TIMEOUT", "file transfer was cancelled or timed out", { retryable: true });
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw fileTooLarge(bytes, maxBytes);
      hash.update(buffer);
      await writeAll(handle, buffer);
    }
    await handle.sync();
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new ToolDomainError("INTERNAL_ERROR", "file write made no progress");
    offset += bytesWritten;
  }
}

function createTransferGuard(timeoutSeconds: number): {
  signal: AbortSignal;
  close: () => void;
  mapError: (error: unknown) => unknown;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("file_transfer_timeout"));
  }, timeoutSeconds * 1000);
  timer.unref?.();
  return {
    signal: controller.signal,
    close: () => clearTimeout(timer),
    mapError: (error: unknown): unknown => timedOut
      ? new ToolDomainError("TRANSFER_TIMEOUT", `file transfer exceeded ${timeoutSeconds} seconds`, { retryable: true })
      : error
  };
}

function clampMaxBytes(value: unknown, hardMax: number): number {
  if (value === undefined || value === null) return hardMax;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ToolDomainError("INVALID_ARGUMENT", "maxBytes must be a positive integer");
  if (parsed > hardMax) throw new ToolDomainError("INVALID_ARGUMENT", `maxBytes cannot exceed ${hardMax}`);
  return parsed;
}

function fileTooLarge(actual: number, maxBytes: number): ToolDomainError {
  return new ToolDomainError("FILE_TOO_LARGE", `file_too_large: ${actual} > ${maxBytes}`, {
    details: { bytes: actual, maxBytes }
  });
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeMimeType(value: string | null | undefined): string {
  return String(value || "").split(";", 1)[0]?.trim().toLowerCase() || "";
}

function safeFileName(value: string): string {
  // eslint-disable-next-line no-control-regex
  const name = path.posix.basename(value.trim().replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "_");
  if (!name || name === "." || name === "..") return "file.bin";
  return name.slice(0, 255);
}

export function detectMimeType(filePath: string): string {
  switch (path.posix.extname(filePath).toLowerCase()) {
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".csv": return "text/csv";
    case ".html": return "text/html";
    case ".xml": return "application/xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".doc": return "application/msword";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt": return "application/vnd.ms-powerpoint";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip": return "application/zip";
    case ".gz": return "application/gzip";
    case ".tar": return "application/x-tar";
    case ".rpm": return "application/x-rpm";
    case ".deb": return "application/vnd.debian.binary-package";
    case ".iso": return "application/x-iso9660-image";
    default: return "application/octet-stream";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
