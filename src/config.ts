import { readFileSync } from "node:fs";
import path from "node:path";
import { validateMutationQueueDir } from "./vault/mutationJournal.js";

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function tokenFromEnv(): string {
  const direct = process.env.MCP_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.MCP_TOKEN_FILE?.trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function listEnv(name: string, defaultValue: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function imageAssetIntegrityModeEnv(): "optional" | "required_for_preserve_original" | "required" {
  const raw = (process.env.IMAGE_ASSET_INTEGRITY_MODE || "required_for_preserve_original").trim();
  if (raw === "optional" || raw === "required_for_preserve_original" || raw === "required") return raw;
  return "required_for_preserve_original";
}

export type Config = {
  host: string;
  port: number;
  mcpPath: string;
  publicBaseUrl: string;
  serverName: string;
  serverVersion: string;
  vaultRoot: string;
  defaultWriteDir: string;
  requireToken: boolean;
  token: string;
  allowedOrigins: string[];
  maxReadBytes: number;
  maxSearchBytesPerFile: number;
  maxSearchResults: number;
  maxRequestBytes: number;
  readOnly: boolean;
  enableVaultWrite: boolean;
  enableVaultAppend: boolean;
  enableVaultPatch: boolean;
  enableVaultDelete: boolean;
  enableVaultMove: boolean;
  enableAppendToInbox: boolean;
  enableAuditLog: boolean;
  assetsDirName: string;
  maxImageAssetBytes: number;
  allowedImageMimeTypes: string[];
  imageAssetIntegrityMode: "optional" | "required_for_preserve_original" | "required";
  enableImageAssets: boolean;
  enableExternalReferenceNotes: boolean;
  trashDelete: boolean;
  trashDir: string;
  backupBeforeWrite: boolean;
  backupDir: string;
  auditLogPath: string;
  mutationQueueDir: string;
};

const vaultRoot = path.resolve(process.env.VAULT_ROOT || "/data/vault");
const rawMutationQueueDir = (process.env.MUTATION_QUEUE_DIR || "").trim();

export const config: Config = {
  host: process.env.MCP_HOST || "0.0.0.0",
  port: intEnv("MCP_PORT", 8080),
  mcpPath: process.env.MCP_PATH || "/mcp",
  publicBaseUrl: (process.env.MCP_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
  serverName: process.env.MCP_SERVER_NAME || "obsidian-vault-mcp",
  serverVersion: process.env.MCP_SERVER_VERSION || "0.1.0",
  vaultRoot,
  defaultWriteDir: (process.env.DEFAULT_WRITE_DIR || "98-Inbox").replace(/^\/+|\/+$/g, ""),
  requireToken: boolEnv("MCP_REQUIRE_TOKEN", true),
  token: tokenFromEnv(),
  allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxReadBytes: intEnv("MAX_READ_BYTES", 256 * 1024),
  maxSearchBytesPerFile: intEnv("MAX_SEARCH_BYTES_PER_FILE", 256 * 1024),
  maxSearchResults: intEnv("MAX_SEARCH_RESULTS", 100),
  maxRequestBytes: intEnv("MAX_REQUEST_BYTES", 16 * 1024 * 1024),
  readOnly: boolEnv("READ_ONLY", false),
  enableVaultWrite: boolEnv("ENABLE_VAULT_WRITE", true),
  enableVaultAppend: boolEnv("ENABLE_VAULT_APPEND", true),
  enableVaultPatch: boolEnv("ENABLE_VAULT_PATCH", true),
  enableVaultDelete: boolEnv("ENABLE_VAULT_DELETE", true),
  enableVaultMove: boolEnv("ENABLE_VAULT_MOVE", true),
  enableAppendToInbox: boolEnv("ENABLE_APPEND_TO_INBOX", true),
  enableAuditLog: boolEnv("ENABLE_AUDIT_LOG", true),
  assetsDirName: (process.env.ASSETS_DIR_NAME || "assets").replace(/^\/+|\/+$/g, "") || "assets",
  maxImageAssetBytes: intEnv("MAX_IMAGE_ASSET_BYTES", 10 * 1024 * 1024),
  allowedImageMimeTypes: listEnv("ALLOWED_IMAGE_MIME_TYPES", ["image/png", "image/jpeg", "image/webp", "image/gif"]),
  imageAssetIntegrityMode: imageAssetIntegrityModeEnv(),
  enableImageAssets: boolEnv("ENABLE_IMAGE_ASSETS", true),
  enableExternalReferenceNotes: boolEnv("ENABLE_EXTERNAL_REFERENCE_NOTES", true),
  trashDelete: boolEnv("TRASH_DELETE", true),
  trashDir: (process.env.TRASH_DIR || ".trash").replace(/^\/+|\/+$/g, "") || ".trash",
  backupBeforeWrite: boolEnv("BACKUP_BEFORE_WRITE", true),
  backupDir: (process.env.BACKUP_DIR || ".backups").replace(/^\/+|\/+$/g, "") || ".backups",
  auditLogPath: (process.env.AUDIT_LOG_PATH || "").trim(),
  mutationQueueDir: rawMutationQueueDir ? validateMutationQueueDir(rawMutationQueueDir, vaultRoot) : ""
};
