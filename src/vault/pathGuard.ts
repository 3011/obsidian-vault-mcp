import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_PARTS = new Set([".obsidian", ".livesync", ".git", ".trash", "node_modules"]);
const FORBIDDEN_SUFFIXES = [".tmp", ".swp", ".swo"];

export class PathGuard {
  readonly root: string;
  readonly defaultWriteDir: string;

  constructor(root: string, defaultWriteDir: string) {
    this.root = path.resolve(root);
    this.defaultWriteDir = defaultWriteDir.replace(/^\/+|\/+$/g, "");
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const rootStat = await stat(this.root);
    if (!rootStat.isDirectory()) throw new Error(`Vault root is not a directory: ${this.root}`);
  }

  validateFilePath(rawPath: unknown, { allowMissing = false }: { allowMissing?: boolean } = {}): string {
    if (typeof rawPath !== "string" || rawPath.trim() === "") throw new Error("path is required");
    if (rawPath.includes("\0")) throw new Error("path contains a NUL byte");
    if (path.isAbsolute(rawPath)) throw new Error("absolute paths are not allowed");
    const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/")).replace(/^\/+/, "");
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("path traversal is not allowed");
    }
    if (!normalized.endsWith(".md")) throw new Error("only Markdown .md files are allowed");
    this.assertAllowedParts(normalized);
    if (!allowMissing && normalized.endsWith("/")) throw new Error("file path must not end with /");
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
    if (typeof rawDestination !== "string" || rawDestination.trim() === "") throw new Error("destination is required");
    if (rawDestination.includes("\0")) throw new Error("destination contains a NUL byte");
    if (path.isAbsolute(rawDestination)) throw new Error("destination must be relative");
    const normalized = path.posix.normalize(rawDestination.replaceAll("\\", "/")).replace(/^\/+/, "");
    if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("destination traversal is not allowed");
    }
    this.assertAllowedParts(normalized.replace(/\/+$/, ""));
    if (normalized.endsWith("/")) {
      const filename = path.posix.basename(sourcePath);
      return `${normalized}${filename}`;
    }
    if (!normalized.endsWith(".md")) throw new Error("destination must be a Markdown .md file or directory ending with /");
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

  private assertInsideRoot(absolutePath: string): void {
    const relative = path.relative(this.root, absolutePath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    throw new Error("path escapes the vault root");
  }
}
