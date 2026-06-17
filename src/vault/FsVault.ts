import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";
import { FileLocks } from "./FileLocks.js";
import { PathGuard } from "./pathGuard.js";
import { getDocumentMap } from "../markdown/documentMap.js";
import { frontmatterTags, parseFrontmatter } from "../markdown/frontmatter.js";
import { patchMarkdown, type PatchArgs } from "../markdown/patch.js";

export class FsVault {
  readonly guard: PathGuard;
  private readonly locks = new FileLocks();

  constructor(root: string, defaultWriteDir: string) {
    this.guard = new PathGuard(root, defaultWriteDir);
  }

  async init(): Promise<void> {
    await this.guard.ensureRoot();
  }

  async list(dirPath = ""): Promise<string[]> {
    const relativeDir = this.guard.validateDirPath(dirPath);
    const absoluteDir = this.guard.resolveCreate(relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error: any) => {
      if (error?.code === "ENOENT") throw new Error(`directory not found: ${relativeDir || "/"}`);
      throw error;
    });
    return entries
      .filter((entry) => !entry.name.startsWith(".") || ![".obsidian", ".livesync", ".git", ".trash"].includes(entry.name))
      .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".md")))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort();
  }

  async read(filePath: string, options: { targetType?: string; target?: string; targetDelimiter?: string } = {}): Promise<unknown> {
    const relative = this.guard.validateFilePath(filePath);
    const absolute = await this.guard.resolveExisting(relative);
    const content = await readFile(absolute, "utf8");
    if ((options.targetType == null) !== (options.target == null)) throw new Error("targetType and target must be provided together");
    if (options.targetType && options.target) return this.readTarget(content, options.targetType, options.target, options.targetDelimiter);
    const fileStat = await stat(absolute);
    const frontmatter = parseFrontmatter(content).data;
    const map = getDocumentMap(content);
    return {
      path: relative,
      content,
      frontmatter,
      tags: [...new Set([...frontmatterTags(frontmatter), ...map.tags])].sort(),
      stat: { ctime: fileStat.ctimeMs, mtime: fileStat.mtimeMs, size: fileStat.size },
      links: map.links,
      embeds: map.embeds
    };
  }

  async write(filePath: string, content: string): Promise<void> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    await this.locks.withLock([relative], async () => {
      const absolute = this.guard.resolveCreate(relative);
      await atomicWriteFile(absolute, content);
      audit("vault_write", { path: relative, bytes: Buffer.byteLength(content) });
    });
  }

  async append(filePath: string, content: string): Promise<void> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    await this.locks.withLock([relative], async () => {
      const absolute = this.guard.resolveCreate(relative);
      let existing = "";
      try {
        existing = await readFile(absolute, "utf8");
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      const next = existing.length === 0 ? content : `${existing.endsWith("\n") ? existing : `${existing}\n`}${content}`;
      await atomicWriteFile(absolute, next);
      audit("vault_append", { path: relative, bytes: Buffer.byteLength(content) });
    });
  }

  async appendInbox(title: string, content: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const relative = this.guard.defaultWritePath(title?.trim() || `${today} ChatGPT`);
    await this.append(relative, content);
    return relative;
  }

  async patch(filePath: string, args: PatchArgs): Promise<void> {
    const relative = this.guard.validateFilePath(filePath);
    await this.locks.withLock([relative], async () => {
      const absolute = await this.guard.resolveExisting(relative);
      const content = await readFile(absolute, "utf8");
      await atomicWriteFile(absolute, patchMarkdown(content, args));
      audit("vault_patch", { path: relative, targetType: args.targetType, target: args.target, operation: args.operation });
    });
  }

  async delete(filePath: string): Promise<void> {
    const relative = this.guard.validateFilePath(filePath);
    await this.locks.withLock([relative], async () => {
      const absolute = await this.guard.resolveExisting(relative);
      await rm(absolute);
      audit("vault_delete", { path: relative });
    });
  }

  async move(filePath: string, destination: string, allowOverwrite = false): Promise<string> {
    const sourceRelative = this.guard.validateFilePath(filePath);
    const destinationRelative = this.guard.validateDestination(destination, sourceRelative);
    return this.locks.withLock([sourceRelative, destinationRelative], async () => {
      const sourceAbsolute = await this.guard.resolveExisting(sourceRelative);
      const destinationAbsolute = this.guard.resolveCreate(destinationRelative);
      if (!allowOverwrite) {
        try {
          await stat(destinationAbsolute);
          throw new Error(`destination already exists: ${destinationRelative}`);
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await mkdir(path.dirname(destinationAbsolute), { recursive: true });
      if (allowOverwrite) await rm(destinationAbsolute, { force: true });
      await rename(sourceAbsolute, destinationAbsolute);
      audit("vault_move", { path: sourceRelative, destination: destinationRelative, allowOverwrite });
      return destinationRelative;
    });
  }

  async documentMap(filePath: string): Promise<unknown> {
    const relative = this.guard.validateFilePath(filePath);
    const absolute = await this.guard.resolveExisting(relative);
    const content = await readFile(absolute, "utf8");
    const map = getDocumentMap(content);
    return { headings: map.headings, blocks: map.blocks, frontmatterFields: map.frontmatterFields, links: map.links, embeds: map.embeds, tags: map.tags };
  }

  async searchSimple(query: string, contextLength = 100, limit = 100): Promise<unknown[]> {
    if (!query?.trim()) throw new Error("query is required");
    const boundedContext = Math.max(0, Math.min(Number.isFinite(contextLength) ? contextLength : 100, 1000));
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, 500));
    const needle = query.toLowerCase();
    const results: unknown[] = [];
    for await (const relative of this.walkMarkdown()) {
      const absolute = this.guard.resolveCreate(relative);
      const content = await readFile(absolute, "utf8");
      const basename = path.posix.basename(relative, ".md");
      const prefix = `${basename}\n\n`;
      const haystack = `${prefix}${content}`;
      const lower = haystack.toLowerCase();
      const matches: Array<{ match: { start: number; end: number; source: "filename" | "content" }; context: string }> = [];
      let index = lower.indexOf(needle);
      while (index >= 0) {
        const source = index < basename.length ? "filename" : "content";
        const start = source === "filename" ? index : index - prefix.length;
        const end = start + query.length;
        matches.push({
          match: { start, end, source },
          context: haystack.slice(Math.max(0, index - boundedContext), index + query.length + boundedContext)
        });
        index = lower.indexOf(needle, index + Math.max(needle.length, 1));
      }
      if (matches.length === 0) continue;
      results.push({
        filename: relative,
        score: matches.length + query.length / Math.max(haystack.length, 1),
        matches
      });
      if (results.length >= boundedLimit) break;
    }
    results.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0));
    return results;
  }

  async tagList(): Promise<Array<{ name: string; count: number }>> {
    const counts = new Map<string, number>();
    for await (const relative of this.walkMarkdown()) {
      const content = await readFile(this.guard.resolveCreate(relative), "utf8");
      for (const tag of getDocumentMap(content).tags) {
        for (const name of expandTag(tag)) counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
  }

  private readTarget(content: string, targetType: string, target: string, targetDelimiter = "::"): unknown {
    if (targetType === "frontmatter") {
      const value = parseFrontmatter(content).data[target];
      if (value === undefined) throw new Error(`frontmatter key not found: ${target}`);
      return value;
    }
    const map = getDocumentMap(content);
    if (targetType === "heading") {
      const normalized = target.split(targetDelimiter).join("::");
      const heading = map.headingDetails.find((item) => item.path === normalized || item.text === target);
      if (!heading) throw new Error(`heading not found: ${target}`);
      return content.slice(heading.contentStart, heading.end);
    }
    if (targetType === "block") {
      const id = target.replace(/^\^/, "");
      const block = map.blockDetails.find((item) => item.id === id);
      if (!block) throw new Error(`block not found: ${target}`);
      return content.slice(block.start, block.end);
    }
    throw new Error(`unsupported targetType: ${targetType}`);
  }

  private async *walkMarkdown(dir = ""): AsyncGenerator<string> {
    const absolute = this.guard.resolveCreate(dir);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      try {
        if (entry.isDirectory()) {
          this.guard.validateDirPath(relative);
          yield* this.walkMarkdown(relative);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          yield this.guard.validateFilePath(relative);
        }
      } catch {
        // Skip hidden or disallowed paths.
      }
    }
  }
}

function expandTag(tag: string): string[] {
  const parts = tag.replace(/^#/, "").split("/");
  const names: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) names.push(parts.slice(0, index).join("/"));
  return names.filter(Boolean);
}

function audit(tool: string, details: Record<string, unknown>): void {
  if (process.env.ENABLE_AUDIT_LOG === "false") return;
  console.log(JSON.stringify({
    level: "info",
    event: "vault_mutation",
    tool,
    ...details,
    timestamp: new Date().toISOString()
  }));
}
