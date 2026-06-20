import { createHash } from "node:crypto";
import path from "node:path";

export type ImageAssetInput = {
  filename: string;
  mimeType: string;
  contentBase64: string;
  expectedSha256?: string;
  expectedSize?: number;
  preserveOriginal?: boolean;
};

export type ImageAssetIntegrityMode = "optional" | "required_for_preserve_original" | "required";

export type ImageAssetIntegrity = {
  mode: ImageAssetIntegrityMode;
  preserveOriginal: boolean;
  expectedSha256Matched?: boolean;
  expectedSizeMatched?: boolean;
  verified: boolean;
};

export type PreparedImageAsset = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  extension: string;
  integrity: ImageAssetIntegrity;
  expectedSha256?: string;
  expectedSize?: number;
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

export function prepareImageAsset(input: ImageAssetInput, allowedMimeTypes: string[], maxBytes: number, integrityMode: ImageAssetIntegrityMode): PreparedImageAsset {
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
  const { integrity, expectedSha256, expectedSize } = validateIntegrity(input, sha256, bytes.length, integrityMode);
  const prepared: PreparedImageAsset = { filename, mimeType, bytes, byteLength: bytes.length, sha256, extension, integrity };
  if (expectedSha256) prepared.expectedSha256 = expectedSha256;
  if (expectedSize != null) prepared.expectedSize = expectedSize;
  return prepared;
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

function validateIntegrity(
  input: ImageAssetInput,
  actualSha256: string,
  actualSize: number,
  mode: ImageAssetIntegrityMode
): { integrity: ImageAssetIntegrity; expectedSha256?: string; expectedSize?: number } {
  const preserveOriginal = input.preserveOriginal === true;
  const expectedSha256 = normalizeExpectedSha256(input.expectedSha256);
  const expectedSize = normalizeExpectedSize(input.expectedSize);
  const expectedSha256Required = mode === "required" || (mode === "required_for_preserve_original" && preserveOriginal);
  const expectedSizeRequired = expectedSha256Required;

  if (expectedSha256Required && !expectedSha256) throw new Error("expectedSha256 is required for image asset integrity verification");
  if (expectedSizeRequired && expectedSize == null) throw new Error("expectedSize is required for image asset integrity verification");

  let expectedSha256Matched: boolean | undefined;
  if (expectedSha256) {
    expectedSha256Matched = expectedSha256 === actualSha256;
    if (!expectedSha256Matched) throw new Error("image asset sha256 does not match expectedSha256");
  }

  let expectedSizeMatched: boolean | undefined;
  if (expectedSize != null) {
    expectedSizeMatched = expectedSize === actualSize;
    if (!expectedSizeMatched) throw new Error("image asset size does not match expectedSize");
  }

  const verified = expectedSha256Matched === true && expectedSizeMatched === true;
  const integrity: ImageAssetIntegrity = { mode, preserveOriginal, verified };
  if (expectedSha256Matched != null) integrity.expectedSha256Matched = expectedSha256Matched;
  if (expectedSizeMatched != null) integrity.expectedSizeMatched = expectedSizeMatched;
  const result: { integrity: ImageAssetIntegrity; expectedSha256?: string; expectedSize?: number } = { integrity };
  if (expectedSha256) result.expectedSha256 = expectedSha256;
  if (expectedSize != null) result.expectedSize = expectedSize;
  return result;
}

function normalizeExpectedSha256(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("expectedSha256 must be a string");
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("expectedSha256 must be a 64 character hex string");
  return normalized;
}

function normalizeExpectedSize(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("expectedSize must be a positive integer");
  return value;
}
