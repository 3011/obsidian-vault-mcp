import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_PARTS = new Set([".obsidian", ".livesync", ".git", ".trash", ".backups", "node_modules"]);
const FORBIDDEN_SUFFIXES = [".tmp", ".swp", ".swo"];

export class PathGuard {
  readonly root: string;
  readonly defaultWriteDir: string;
  constructor(root: string, defaultWriteDir: string) {
    this.root = path.resolve(root);
    this.defaultWriteDir = this.validateDirPath(defaultWriteDir);
    if (!this.defaultWriteDir) throw new Error("default write directory is required");
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const rootStat = await stat(this.root);
    if (!rootStat.isDirectory()) throw new Error(`Vault root is not a directory: ${this.root}`);
  }

  validateFilePath(rawPath: unknown, { allowMissing = false }: { allowMissing?: boolean } = {}): string {
    const normalized = this.validateVaultFilePath(rawPath);
    if (!normalized.endsWith(".md")) throw new Error("only Markdown .md files are allowed");
    if (!allowMissing && normalized.endsWith("/")) throw new Error("file path must not end with /");
    return normalized;
  }

  validateVaultPath(rawPath: unknown): string {
    const normalized = this.validateRelativePath(rawPath, "path").replace(/\/+$/g, "");
    if (!normalized) throw new Error("path is required");
    return normalized;
  }

  validateVaultFilePath(rawPath: unknown): string {
    const normalized = this.validateRelativePath(rawPath, "path");
    if (normalized.endsWith("/")) throw new Error("file path must not end with /");
    return normalized;
  }

  validateDirPath(rawPath: unknown): string {
    if (rawPath == null || rawPath === "") return "";
    if (typeof rawPath !== "string") throw new Error("path must be a string");
    if (rawPath.includes("\0")) throw new Error("path contains a NUL byte");
    if (path.isAbsolute(rawPath)) throw new Error("absolute paths are not allowed");
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/")).replace(/^\/+|\/+$/g, "");
    if (normalized === ".") return "";
    if (normalized.startsWith("../") || normalized.includes("/../")) throw new Error("path traversal is not allowed");
    this.assertAllowedParts(normalized);
    return normalized;
  }

  validateDestination(rawDestination: unknown, sourcePath: string): string {
    const normalized = this.validateRelativePath(rawDestination, "destination");
    if (normalized.endsWith("/")) {
      const filename = path.posix.basename(sourcePath);
      return `${normalized}${filename}`;
    }
    if (!normalized.endsWith(".md")) throw new Error("destination must be a Markdown .md file or directory ending with /");
    return normalized;
  }

  validateVaultDestination(rawDestination: unknown, sourcePath: string): string {
    const normalized = this.validateRelativePath(rawDestination, "destination");
    if (normalized.endsWith("/")) {
      const filename = path.posix.basename(sourcePath);
      return `${normalized}${filename}`;
    }
    return normalized;
  }

  validateDirectoryName(rawName: unknown): string {
    if (typeof rawName !== "string" || rawName.trim() === "") throw new Error("directory name is required");
    const name = rawName.trim();
    if (name.includes("/") || name.includes("\\")) {
      throw new Error("directory name must be a single path segment; create nested directories one level at a time");
    }
    const normalized = this.validateDirPath(name);
    if (!normalized || normalized.includes("/")) throw new Error("directory name must be a single path segment");
    return normalized;
  }

  validateAssetDir(rawPath: unknown): string {
    const normalized = this.validateDirPath(rawPath);
    if (!normalized) throw new Error("asset directory is required");
    return normalized;
  }

  validateAssetPath(rawPath: unknown, allowedExtensions: string[]): string {
    if (typeof rawPath !== "string" || rawPath.trim() === "") throw new Error("asset path is required");
    if (rawPath.includes("\0")) throw new Error("asset path contains a NUL byte");
    if (path.isAbsolute(rawPath)) throw new Error("absolute asset paths are not allowed");
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/")).replace(/^\/+/, "");
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("asset path traversal is not allowed");
    }
    this.assertAllowedParts(normalized);
    if (normalized.endsWith("/")) throw new Error("asset path must not end with /");
    const ext = path.posix.extname(normalized).toLowerCase();
    if (!allowedExtensions.includes(ext)) throw new Error(`asset extension is not allowed: ${ext || "(none)"}`);
    return normalized;
  }

  resolveCreate(relativePath: string): string {
    const absolute = path.resolve(this.root, relativePath);
    this.assertInsideRoot(absolute);
    return absolute;
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const absolute = this.resolveCreate(relativePath);
    const fileStat = await lstat(absolute);
    if (!fileStat.isFile()) throw new Error("path is not a regular file");
    const real = await realpath(absolute);
    this.assertInsideRoot(real);
    return real;
  }

  async resolveExistingPath(relativePath: string): Promise<{ absolute: string; type: "file" | "directory" }> {
    const absolute = this.resolveCreate(relativePath);
    const fileStat = await lstat(absolute);
    if (!fileStat.isFile() && !fileStat.isDirectory()) throw new Error("path is not a regular file or directory");
    const real = await realpath(absolute);
    this.assertInsideRoot(real);
    return { absolute, type: fileStat.isDirectory() ? "directory" : "file" };
  }

  async assertWritableParent(relativePath: string): Promise<void> {
    const parent = path.posix.dirname(relativePath);
    if (parent === "." || parent === "") {
      throw new Error("writes to the vault root are not allowed; choose an existing directory or use append_to_inbox");
    }
    await this.assertWritableDirectory(parent, "parent directory");
  }

  async assertWritableDirectory(relativeDir: string, label = "directory"): Promise<void> {
    const normalized = this.validateDirPath(relativeDir);
    if (!normalized) {
      throw new Error("the vault root cannot be used as a write directory; choose an existing subdirectory or use append_to_inbox");
    }
    const absolute = this.resolveCreate(normalized);
    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try {
      fileStat = await lstat(absolute);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error(`${label} not found: ${normalized}. This server never creates directories implicitly; choose an existing directory or use append_to_inbox`, { cause: error });
      }
      throw error;
    }
    if (!fileStat.isDirectory()) throw new Error(`${label} is not a directory: ${normalized}`);
    const real = await realpath(absolute);
    this.assertInsideRoot(real);
  }

  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath).split(path.sep).join("/");
  }

  defaultWritePath(filename: string): string {
    const clean = filename
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+|\.+$/g, "");
    const base = clean || "ChatGPT";
    return `${this.defaultWriteDir}/${base.endsWith(".md") ? base : `${base}.md`}`;
  }

  private assertAllowedParts(relativePath: string): void {
    if (!relativePath) return;
    for (const part of relativePath.split("/")) {
      if (!part || part === "." || part === "..") throw new Error("invalid path segment");
      if (FORBIDDEN_PARTS.has(part)) throw new Error(`path segment is not allowed: ${part}`);
    }
    const base = path.posix.basename(relativePath);
    if (base === ".DS_Store" || FORBIDDEN_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      throw new Error("temporary files are not allowed");
    }
  }

  private validateRelativePath(rawPath: unknown, label: "path" | "destination"): string {
    if (typeof rawPath !== "string" || rawPath.trim() === "") throw new Error(`${label} is required`);
    if (rawPath.includes("\0")) throw new Error(`${label} contains a NUL byte`);
    if (path.isAbsolute(rawPath)) throw new Error(label === "destination" ? "destination must be relative" : "absolute paths are not allowed");
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/")).replace(/^\/+/, "");
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error(label === "destination" ? "destination traversal is not allowed" : "path traversal is not allowed");
    }
    this.assertAllowedParts(normalized.replace(/\/+$/, ""));
    return normalized;
  }

  private assertInsideRoot(absolutePath: string): void {
    const relative = path.relative(this.root, absolutePath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    throw new Error("path escapes the vault root");
  }
}
