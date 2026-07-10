import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";
import { audit } from "./audit.js";
import { assetAudit, findAssetReferences, vaultListDetailed, type AssetAuditArgs, type FindAssetReferencesArgs, type VaultListDetailedArgs } from "./assetAudit.js";
import { FileLocks } from "./FileLocks.js";
import { PathGuard } from "./pathGuard.js";
import { MutationJournal } from "./mutationJournal.js";
import { getDocumentMap } from "../markdown/documentMap.js";
import { frontmatterTags, parseFrontmatter } from "../markdown/frontmatter.js";
import { patchMarkdown, type PatchArgs } from "../markdown/patch.js";
import { allowedImageExtensions, prepareImageAsset, uniqueAssetFilename, type ImageAssetInput, type ImageAssetIntegrity, type ImageAssetIntegrityMode, type PreparedImageAsset } from "./imageAssets.js";

export type ImageAssetResult = {
  path: string;
  embed: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  integrity: ImageAssetIntegrity;
};

export type ExternalReference = {
  label: string;
  location: string;
  type?: string;
  note?: string;
};

export type SearchQueryArgs = {
  pathGlob?: string;
  tag?: string;
  frontmatter?: Record<string, unknown>;
  content?: string;
  limit?: number;
};

export class FsVault {
  readonly guard: PathGuard;
  private readonly locks = new FileLocks();
  private readonly assetsDirName: string;
  private readonly maxImageAssetBytes: number;
  private readonly allowedImageMimeTypes: string[];
  private readonly imageAssetIntegrityMode: ImageAssetIntegrityMode;
  private readonly trashDelete: boolean;
  private readonly trashDir: string;
  private readonly backupBeforeWrite: boolean;
  private readonly backupDir: string;
  private readonly mutationJournal: MutationJournal | undefined;
  private readonly validateDefaultWriteDir: boolean;
  private readonly validateDefaultAssetDir: boolean;

  constructor(root: string, defaultWriteDir: string, options: {
    assetsDirName?: string;
    maxImageAssetBytes?: number;
    allowedImageMimeTypes?: string[];
    imageAssetIntegrityMode?: ImageAssetIntegrityMode;
    trashDelete?: boolean;
    trashDir?: string;
    backupBeforeWrite?: boolean;
    backupDir?: string;
    mutationJournal?: MutationJournal | undefined;
    validateDefaultWriteDir?: boolean;
    validateDefaultAssetDir?: boolean;
  } = {}) {
    this.guard = new PathGuard(root, defaultWriteDir);
    this.assetsDirName = sanitizeDirName(options.assetsDirName || "assets");
    this.maxImageAssetBytes = options.maxImageAssetBytes || 10 * 1024 * 1024;
    this.allowedImageMimeTypes = options.allowedImageMimeTypes || ["image/png", "image/jpeg", "image/webp", "image/gif"];
    this.imageAssetIntegrityMode = options.imageAssetIntegrityMode || "required_for_preserve_original";
    this.trashDelete = options.trashDelete ?? true;
    this.trashDir = sanitizeDirName(options.trashDir || ".trash");
    this.backupBeforeWrite = options.backupBeforeWrite ?? true;
    this.backupDir = sanitizeDirName(options.backupDir || ".backups");
    this.mutationJournal = options.mutationJournal;
    this.validateDefaultWriteDir = options.validateDefaultWriteDir ?? false;
    this.validateDefaultAssetDir = options.validateDefaultAssetDir ?? false;
  }

  async init(): Promise<void> {
    await this.guard.ensureRoot();
    if (this.validateDefaultWriteDir) {
      await this.guard.assertWritableDirectory(this.guard.defaultWriteDir, "default write directory");
    }
    if (this.validateDefaultAssetDir) {
      await this.guard.assertWritableDirectory(`${this.guard.defaultWriteDir}/${this.assetsDirName}`, "default asset directory");
    }
    await this.mutationJournal?.init();
  }

  async list(dirPath = ""): Promise<string[]> {
    const relativeDir = this.guard.validateDirPath(dirPath);
    const absoluteDir = this.guard.resolveCreate(relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error: any) => {
      if (error?.code === "ENOENT") throw new Error(`directory not found: ${relativeDir || "/"}`);
      throw error;
    });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .filter((entry) => {
        try {
          if (entry.endsWith("/")) this.guard.validateDirPath(`${relativeDir}/${entry}`.replace(/^\/+/, ""));
          else this.guard.validateVaultFilePath(`${relativeDir}/${entry}`.replace(/^\/+/, ""));
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  async listDetailed(args: VaultListDetailedArgs): Promise<unknown> {
    return vaultListDetailed(this.guard, args);
  }

  async read(filePath: string, options: { targetType?: string; target?: string; targetDelimiter?: string } = {}): Promise<unknown> {
    const relative = this.guard.validateVaultFilePath(filePath);
    const absolute = await this.guard.resolveExisting(relative);
    if (!relative.endsWith(".md")) {
      if (options.targetType || options.target) throw new Error("targeted reads are only supported for Markdown .md files");
      if (!isTextReadablePath(relative)) throw new Error("binary files cannot be read with vault_read");
      const content = await readFile(absolute, "utf8");
      const fileStat = await stat(absolute);
      return {
        path: relative,
        content,
        stat: { ctime: fileStat.ctimeMs, mtime: fileStat.mtimeMs, size: fileStat.size }
      };
    }
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
      try {
        await this.guard.assertWritableParent(relative);
        const absolute = this.guard.resolveCreate(relative);
        await this.backupExisting(relative, "vault_write");
        await atomicWriteFile(absolute, content);
        await audit("vault_write", "success", { path: relative, bytes: Buffer.byteLength(content) });
      } catch (error) {
        await audit("vault_write", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async append(filePath: string, content: string): Promise<void> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    await this.locks.withLock([relative], async () => {
      await this.guard.assertWritableParent(relative);
      const absolute = this.guard.resolveCreate(relative);
      let existing = "";
      try {
        existing = await readFile(absolute, "utf8");
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      const next = existing.length === 0 ? content : `${existing.endsWith("\n") ? existing : `${existing}\n`}${content}`;
      try {
        await this.backupExisting(relative, "vault_append");
        await atomicWriteFile(absolute, next);
        await audit("vault_append", "success", { path: relative, bytes: Buffer.byteLength(content) });
      } catch (error) {
        await audit("vault_append", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async appendInbox(title: string, content: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const relative = this.guard.defaultWritePath(title?.trim() || `${today} ChatGPT`);
    await this.append(relative, content);
    return relative;
  }

  async uploadImageAsset(input: ImageAssetInput & { dir?: string }): Promise<ImageAssetResult> {
    const assetDir = this.guard.validateAssetDir(input.dir || `${this.guard.defaultWriteDir}/${this.assetsDirName}`);
    this.assertAssetDir(assetDir);
    const asset = prepareImageAsset(input, this.allowedImageMimeTypes, this.maxImageAssetBytes, this.imageAssetIntegrityMode);
    return this.savePreparedImageAsset(assetDir, asset);
  }

  async createNoteWithAssets(filePath: string, content: string, assets: ImageAssetInput[]): Promise<{ path: string; assets: ImageAssetResult[] }> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    const noteDir = path.posix.dirname(relative);
    const assetDir = noteDir === "." ? this.assetsDirName : `${noteDir}/${this.assetsDirName}`;
    const prepared = assets.map((asset) => prepareImageAsset(asset, this.allowedImageMimeTypes, this.maxImageAssetBytes, this.imageAssetIntegrityMode));
    validateAssetPlaceholders(content, prepared.length);

    return this.locks.withLock([relative], async () => {
      const savedAssets: ImageAssetResult[] = [];
      try {
        await this.guard.assertWritableParent(relative);
        await this.guard.assertWritableDirectory(assetDir, "asset directory");
        for (const asset of prepared) savedAssets.push(await this.savePreparedImageAsset(assetDir, asset));
        const noteContent = renderNoteWithAssets(content, savedAssets);
        const absolute = this.guard.resolveCreate(relative);
        await this.backupExisting(relative, "vault_create_note_with_assets");
        await atomicWriteFile(absolute, noteContent);
        await audit("vault_create_note_with_assets", "success", { path: relative, assets: savedAssets.map((asset) => asset.path), bytes: Buffer.byteLength(noteContent) });
        return { path: relative, assets: savedAssets };
      } catch (error) {
        await audit("vault_create_note_with_assets", "failure", { path: relative, assets: savedAssets.map((asset) => asset.path), error: errorMessage(error) });
        throw error;
      }
    });
  }

  async createExternalReferenceNote(args: {
    path: string;
    title: string;
    references: ExternalReference[];
    summary?: string;
    keyFindings?: string[];
    nextActions?: string[];
  }): Promise<{ path: string }> {
    const relative = this.guard.validateFilePath(args.path, { allowMissing: true });
    if (!args.title.trim()) throw new Error("title is required");
    if (!Array.isArray(args.references) || args.references.length === 0) throw new Error("references must contain at least one item");
    for (const reference of args.references) {
      if (!reference.label.trim()) throw new Error("reference label is required");
      if (!reference.location.trim()) throw new Error("reference location is required");
    }
    const content = renderExternalReferenceNote(args);
    try {
      await this.write(relative, content);
      await audit("vault_create_external_reference_note", "success", { path: relative, references: args.references.length });
      return { path: relative };
    } catch (error) {
      await audit("vault_create_external_reference_note", "failure", { path: relative, references: args.references.length, error: errorMessage(error) });
      throw error;
    }
  }

  async patch(filePath: string, args: PatchArgs): Promise<void> {
    const relative = this.guard.validateFilePath(filePath);
    await this.locks.withLock([relative], async () => {
      try {
        const absolute = await this.guard.resolveExisting(relative);
        const content = await readFile(absolute, "utf8");
        await this.backupExisting(relative, "vault_patch");
        await atomicWriteFile(absolute, patchMarkdown(content, args));
        await audit("vault_patch", "success", { path: relative, targetType: args.targetType, target: args.target, operation: args.operation });
      } catch (error) {
        await audit("vault_patch", "failure", { path: relative, targetType: args.targetType, target: args.target, operation: args.operation, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async createDirectory(parentPath: string, name: string, reason: string): Promise<{ path: string }> {
    const parent = this.guard.validateDirPath(parentPath);
    const directoryName = this.guard.validateDirectoryName(name);
    const creationReason = reason.trim();
    if (!creationReason) throw new Error("reason is required and must explain why no existing directory is suitable");
    if (creationReason.length > 1000) throw new Error("reason must not exceed 1000 characters");
    const relative = this.guard.validateDirPath(parent ? `${parent}/${directoryName}` : directoryName);
    const portableNameKey = directoryName.normalize("NFC").toLocaleLowerCase("en-US");
    const portableNameLock = `directory-name:${parent}/${portableNameKey}`;

    return this.locks.withLock([relative, portableNameLock], async () => {
      try {
        if (parent) await this.guard.assertWritableDirectory(parent, "parent directory");
        const parentAbsolute = parent ? this.guard.resolveCreate(parent) : this.guard.root;
        const siblings = await readdir(parentAbsolute, { withFileTypes: true });
        const conflictingSibling = siblings.find((entry) =>
          entry.name.normalize("NFC").toLocaleLowerCase("en-US") === portableNameKey
        );
        if (conflictingSibling) {
          if (conflictingSibling.name === directoryName && conflictingSibling.isDirectory()) {
            throw new Error(`directory already exists: ${relative}; reuse the existing directory instead`);
          }
          if (conflictingSibling.name === directoryName) {
            throw new Error(`path already exists and is not a directory: ${relative}`);
          }
          throw new Error(`directory name conflicts with existing path: ${conflictingSibling.name}; choose a distinct portable name`);
        }

        const absolute = this.guard.resolveCreate(relative);
        try {
          await mkdir(absolute);
        } catch (error: any) {
          if (error?.code === "EEXIST") {
            const existing = await stat(absolute).catch(() => undefined);
            if (existing?.isDirectory()) {
              throw new Error(`directory already exists: ${relative}; reuse the existing directory instead`, { cause: error });
            }
            throw new Error(`path already exists and is not a directory: ${relative}`, { cause: error });
          }
          if (error?.code === "ENOENT") throw new Error(`parent directory not found: ${parent || "/"}; create directories one level at a time`, { cause: error });
          throw error;
        }
        await audit("vault_create_directory", "success", { path: relative, parent, name: directoryName, reason: creationReason });
        return { path: relative };
      } catch (error) {
        await audit("vault_create_directory", "failure", { path: relative, parent, name: directoryName, reason: creationReason, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async delete(filePath: string): Promise<void> {
    const relative = this.guard.validateVaultPath(filePath);
    await this.locks.withLock([relative], async () => {
      try {
        const existing = await this.guard.resolveExistingPath(relative);
        if (existing.type === "directory") {
          await rmdir(existing.absolute);
          await audit("vault_delete", "success", { path: relative, directory: true });
          return;
        }
        const absolute = existing.absolute;
        await this.backupExisting(relative, "vault_delete");
        if (this.trashDelete) {
          const trashRelative = await this.allocateRecoveryPath(this.trashDir, relative, "vault_delete");
          const trashAbsolute = this.guard.resolveCreate(trashRelative);
          await mkdir(path.dirname(trashAbsolute), { recursive: true });
          const mutation = await this.mutationJournal?.createDelete(relative);
          await rename(absolute, trashAbsolute);
          await mutation?.markReady({ trashPath: trashRelative });
          await audit("vault_delete", "success", { path: relative, trashPath: trashRelative });
        } else {
          const mutation = await this.mutationJournal?.createDelete(relative);
          await rm(absolute);
          await mutation?.markReady();
          await audit("vault_delete", "success", { path: relative, permanent: true });
        }
      } catch (error) {
        await audit("vault_delete", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async move(filePath: string, destination: string, allowOverwrite = false): Promise<string> {
    const sourceRelative = this.guard.validateVaultFilePath(filePath);
    const destinationRelative = this.guard.validateVaultDestination(destination, sourceRelative);
    const sourceIsMarkdown = sourceRelative.endsWith(".md");
    if (sourceIsMarkdown !== destinationRelative.endsWith(".md")) {
      throw new Error("vault_move cannot change a file between Markdown and non-Markdown extensions");
    }
    return this.locks.withLock([sourceRelative, destinationRelative], async () => {
      try {
        const sourceAbsolute = await this.guard.resolveExisting(sourceRelative);
        await this.guard.assertWritableParent(destinationRelative);
        const destinationAbsolute = this.guard.resolveCreate(destinationRelative);
        if (!allowOverwrite) {
          try {
            await stat(destinationAbsolute);
            throw new Error(`destination already exists: ${destinationRelative}`);
          } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        await this.backupExisting(sourceRelative, "vault_move");
        if (allowOverwrite) await this.backupExisting(destinationRelative, "vault_move_overwrite");
        const mutation = await this.mutationJournal?.createMove(sourceRelative, destinationRelative, allowOverwrite);
        if (allowOverwrite) await rm(destinationAbsolute, { force: true });
        await rename(sourceAbsolute, destinationAbsolute);
        await mutation?.markReady();
        await audit("vault_move", "success", { path: sourceRelative, destination: destinationRelative, allowOverwrite });
        return destinationRelative;
      } catch (error) {
        await audit("vault_move", "failure", { path: sourceRelative, destination: destinationRelative, allowOverwrite, error: errorMessage(error) });
        throw error;
      }
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

  async searchQuery(args: SearchQueryArgs): Promise<unknown[]> {
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(args.limit) ? Number(args.limit) : 100, 500));
    const pathRegexp = args.pathGlob?.trim() ? globToRegExp(args.pathGlob.trim()) : undefined;
    const tag = args.tag?.replace(/^#/, "");
    const contentNeedle = args.content?.toLowerCase();
    const frontmatter = args.frontmatter && typeof args.frontmatter === "object" && !Array.isArray(args.frontmatter) ? args.frontmatter : undefined;
    const results: unknown[] = [];
    for await (const relative of this.walkMarkdown()) {
      if (pathRegexp && !pathRegexp.test(relative)) continue;
      const absolute = this.guard.resolveCreate(relative);
      const content = await readFile(absolute, "utf8");
      if (contentNeedle && !content.toLowerCase().includes(contentNeedle)) continue;
      const parsedFrontmatter = parseFrontmatter(content).data;
      const map = getDocumentMap(content);
      const tags = [...new Set([...frontmatterTags(parsedFrontmatter), ...map.tags])].sort();
      if (tag && !tags.map((item) => item.replace(/^#/, "")).includes(tag)) continue;
      if (frontmatter && !frontmatterMatches(parsedFrontmatter, frontmatter)) continue;
      const fileStat = await stat(absolute);
      results.push({
        filename: relative,
        frontmatter: parsedFrontmatter,
        tags,
        stat: { ctime: fileStat.ctimeMs, mtime: fileStat.mtimeMs, size: fileStat.size },
        links: map.links,
        embeds: map.embeds
      });
      if (results.length >= boundedLimit) break;
    }
    return results;
  }

  async findAssetReferences(args: FindAssetReferencesArgs): Promise<unknown> {
    const input: FindAssetReferencesArgs = { assetPaths: args.assetPaths };
    if (args.scope != null) input.scope = this.guard.validateDirPath(args.scope);
    return findAssetReferences(this.guard, input);
  }

  async assetAudit(args: AssetAuditArgs): Promise<unknown> {
    const input: AssetAuditArgs = { root: this.guard.validateDirPath(args.root) };
    if (args.recursive != null) input.recursive = args.recursive;
    if (args.includeSha256 != null) input.includeSha256 = args.includeSha256;
    if (args.scope != null) input.scope = this.guard.validateDirPath(args.scope);
    return assetAudit(this.guard, input);
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

  private async savePreparedImageAsset(assetDir: string, asset: PreparedImageAsset): Promise<ImageAssetResult> {
    const allowedExtensions = allowedImageExtensions(this.allowedImageMimeTypes);
    const dir = this.guard.validateAssetDir(assetDir);
    this.assertAssetDir(dir);
    await this.guard.assertWritableDirectory(dir, "asset directory");
    const filename = await uniqueAssetFilename(asset.filename, asset.sha256, async (candidate) => {
      try {
        await stat(this.guard.resolveCreate(this.guard.validateAssetPath(`${dir}/${candidate}`, allowedExtensions)));
        return true;
      } catch (error: any) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    });
    const relative = this.guard.validateAssetPath(`${dir}/${filename}`, allowedExtensions);
    return this.locks.withLock([relative], async () => {
      try {
        const absolute = this.guard.resolveCreate(relative);
        await atomicWriteFile(absolute, asset.bytes);
        await audit("vault_upload_image_asset", "success", assetAuditDetails(relative, asset));
        return {
          path: relative,
          embed: `![[${relative}]]`,
          bytes: asset.byteLength,
          sha256: asset.sha256,
          mimeType: asset.mimeType,
          integrity: asset.integrity
        };
      } catch (error) {
        await audit("vault_upload_image_asset", "failure", { ...assetAuditDetails(relative, asset), error: errorMessage(error) });
        throw error;
      }
    });
  }

  private assertAssetDir(assetDir: string): void {
    if (path.posix.basename(assetDir) !== this.assetsDirName) {
      throw new Error(`image assets must be stored in a '${this.assetsDirName}' directory`);
    }
  }

  private async backupExisting(relative: string, operation: string): Promise<string | undefined> {
    if (!this.backupBeforeWrite) return undefined;
    const source = this.guard.resolveCreate(relative);
    try {
      await stat(source);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    const backupRelative = await this.allocateRecoveryPath(this.backupDir, relative, operation);
    const backupAbsolute = this.guard.resolveCreate(backupRelative);
    await mkdir(path.dirname(backupAbsolute), { recursive: true });
    await copyFile(source, backupAbsolute);
    await audit("vault_backup", "success", { path: relative, backupPath: backupRelative, operation });
    return backupRelative;
  }

  private async allocateRecoveryPath(baseDir: string, relative: string, operation: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const parsed = path.posix.parse(relative);
    const safeOperation = operation.replace(/[^a-z0-9_-]/gi, "-");
    const baseRelative = `${baseDir}/${timestamp}/${parsed.dir}/${parsed.name}.${safeOperation}${parsed.ext}`.replace(/\/+/g, "/");
    for (let index = 0; index < 1000; index += 1) {
      const candidate = index === 0 ? baseRelative : baseRelative.replace(new RegExp(`${escapeRegExp(parsed.ext)}$`), `.${index}${parsed.ext}`);
      try {
        await stat(this.guard.resolveCreate(candidate));
      } catch (error: any) {
        if (error?.code === "ENOENT") return candidate;
        throw error;
      }
    }
    throw new Error(`could not allocate recovery path for ${relative}`);
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

function sanitizeDirName(name: string): string {
  const clean = name.replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/") || clean.includes("\\") || clean.includes("\0") || clean === "." || clean === "..") {
    throw new Error("ASSETS_DIR_NAME must be a single relative directory name");
  }
  return clean;
}

function validateAssetPlaceholders(content: string, assetCount: number): void {
  for (const match of content.matchAll(/\{\{asset:(\d+)}}/g)) {
    const index = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(index) || index < 0 || index >= assetCount) throw new Error(`asset placeholder index is out of range: ${match[0]}`);
  }
}

function renderNoteWithAssets(content: string, assets: ImageAssetResult[]): string {
  const referenced = new Set<number>();
  let next = content.replace(/\{\{asset:(\d+)}}/g, (placeholder, rawIndex) => {
    const index = Number.parseInt(rawIndex, 10);
    const asset = assets[index];
    if (!asset) return placeholder;
    referenced.add(index);
    return asset.embed;
  });
  const unreferenced = assets.filter((_, index) => !referenced.has(index));
  if (unreferenced.length > 0) {
    const separator = next.endsWith("\n") ? "\n" : "\n\n";
    next += `${separator}## Assets\n\n${unreferenced.map((asset) => asset.embed).join("\n")}\n`;
  }
  return next;
}

function renderExternalReferenceNote(args: {
  title: string;
  references: ExternalReference[];
  summary?: string;
  keyFindings?: string[];
  nextActions?: string[];
}): string {
  const lines = [
    "---",
    `created: ${new Date().toISOString().slice(0, 10)}`,
    "source: chatgpt",
    "type: external-reference-note",
    "---",
    "",
    `# ${args.title.trim()}`,
    "",
    "## 原始材料",
    ""
  ];
  for (const reference of args.references) {
    const suffix = [
      reference.type ? `type: ${reference.type}` : "",
      reference.note ? `note: ${reference.note}` : ""
    ].filter(Boolean).join("; ");
    lines.push(`- ${reference.label.trim()}：\`${reference.location.trim()}\`${suffix ? ` (${suffix})` : ""}`);
  }
  if (args.summary?.trim()) lines.push("", "## 摘要", "", args.summary.trim());
  appendListSection(lines, "关键发现", args.keyFindings);
  appendListSection(lines, "下一步", args.nextActions);
  lines.push("");
  return lines.join("\n");
}

function appendListSection(lines: string[], title: string, values: string[] | undefined): void {
  const items = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (items.length === 0) return;
  lines.push("", `## ${title}`, "");
  for (const item of items) lines.push(`- ${item}`);
}

function expandTag(tag: string): string[] {
  const parts = tag.replace(/^#/, "").split("/");
  const names: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) names.push(parts.slice(0, index).join("/"));
  return names.filter(Boolean);
}

function isTextReadablePath(relative: string): boolean {
  return new Set([".txt", ".json", ".yaml", ".yml", ".csv", ".log", ".xml", ".html", ".css", ".js", ".ts"]).has(path.posix.extname(relative).toLowerCase());
}

function frontmatterMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split(/(\*\*)/g).map((part) => {
    if (part === "**") return ".*";
    return part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  }).join("");
  return new RegExp(`^${escaped}$`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assetAuditDetails(relative: string, asset: PreparedImageAsset): Record<string, unknown> {
  return {
    path: relative,
    bytes: asset.byteLength,
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    expectedSha256: asset.expectedSha256,
    expectedSize: asset.expectedSize,
    preserveOriginal: asset.integrity.preserveOriginal,
    integrityVerified: asset.integrity.verified
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
