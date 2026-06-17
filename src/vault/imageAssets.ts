import { createHash } from "node:crypto";
import path from "node:path";

export type ImageAssetInput = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type PreparedImageAsset = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  extension: string;
};

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

export function allowedImageExtensions(allowedMimeTypes: string[]): string[] {
  return [...new Set(allowedMimeTypes.map((mime) => MIME_EXTENSIONS[mime]).filter((value): value is string => Boolean(value)))];
}

export function prepareImageAsset(input: ImageAssetInput, allowedMimeTypes: string[], maxBytes: number): PreparedImageAsset {
  const mimeType = input.mimeType.trim().toLowerCase();
  if (!allowedMimeTypes.includes(mimeType)) throw new Error(`image MIME type is not allowed: ${mimeType}`);

  const base64 = input.contentBase64.trim();
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new Error("contentBase64 is not valid base64");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new Error("image asset is empty");
  if (bytes.length > maxBytes) throw new Error(`image asset exceeds maximum size of ${maxBytes} bytes`);
  if (!magicMatches(mimeType, bytes)) throw new Error(`image content does not match MIME type: ${mimeType}`);

  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error(`image MIME type is not supported: ${mimeType}`);
  const filename = sanitizeAssetFilename(input.filename, extension);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { filename, mimeType, bytes, byteLength: bytes.length, sha256, extension };
}

export function sanitizeAssetFilename(filename: string, requiredExtension: string): string {
  const cleaned = filename
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  const parsed = path.posix.parse(cleaned || "image");
  const name = (parsed.name || "image").slice(0, 120);
  const currentExtension = parsed.ext.toLowerCase();
  if (currentExtension && currentExtension !== requiredExtension && !(requiredExtension === ".jpg" && currentExtension === ".jpeg")) {
    throw new Error(`filename extension does not match MIME type: ${currentExtension}`);
  }
  const finalExtension = currentExtension === ".jpeg" ? ".jpg" : requiredExtension;
  return `${name}${finalExtension}`;
}

export function uniqueAssetFilename(filename: string, sha256: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
  return uniqueAssetFilenameInner(filename, sha256, exists);
}

async function uniqueAssetFilenameInner(filename: string, sha256: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(filename))) return filename;
  const parsed = path.posix.parse(filename);
  const suffix = sha256.slice(0, 12);
  const candidate = `${parsed.name}-${suffix}${parsed.ext}`;
  if (!(await exists(candidate))) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    const indexed = `${parsed.name}-${suffix}-${index}${parsed.ext}`;
    if (!(await exists(indexed))) return indexed;
  }
  throw new Error(`could not allocate unique filename for ${filename}`);
}

function magicMatches(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
  if (mimeType === "image/webp") {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
  }
  return false;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}
