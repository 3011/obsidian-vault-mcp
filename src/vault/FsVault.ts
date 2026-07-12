import { copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicCreateFile, atomicWriteFile } from "./atomicWrite.js";
import { ToolDomainError } from "../mcp/errors.js";
import { audit } from "./audit.js";
import { assetAudit, findAssetReferences, vaultListDetailed, type AssetAuditArgs, type FindAssetReferencesArgs, type VaultListDetailedArgs } from "./assetAudit.js";
import { FileLocks } from "./FileLocks.js";
import { PathGuard } from "./pathGuard.js";
import { MutationJournal, type OperationStatus, type PendingMutation } from "./mutationJournal.js";
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

export type FileRevision = {
  sha256: string;
  size: number;
  mtimeMs: number;
};

export type LocalFileMutationResult = {
  path: string;
  revision: FileRevision;
};

export type DeleteMutationResult = {
  path: string;
  operationId?: string;
};

export type MoveMutationResult = {
  oldPath: string;
  newPath: string;
  operationId?: string;
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
    return this.locks.withLock([relative], async () => {
      const absolute = await this.guard.resolveExisting(relative);
      const snapshot = await readSnapshot(absolute);
      const content = snapshot.bytes.toString("utf8");
      if (!relative.endsWith(".md")) {
        if (options.targetType || options.target) throw new Error("targeted reads are only supported for Markdown .md files");
        if (!isTextReadablePath(relative)) throw new Error("binary files cannot be read with vault_read");
        return {
          path: relative,
          content,
          stat: { ctime: snapshot.ctimeMs, mtime: snapshot.mtimeMs, size: snapshot.bytes.length },
          revision: revisionFromBytes(snapshot.bytes, snapshot.mtimeMs)
        };
      }
      if ((options.targetType == null) !== (options.target == null)) throw new Error("targetType and target must be provided together");
      if (options.targetType && options.target) return this.readTarget(content, options.targetType, options.target, options.targetDelimiter);
      const frontmatter = parseFrontmatter(content).data;
      const map = getDocumentMap(content);
      return {
        path: relative,
        content,
        frontmatter,
        tags: [...new Set([...frontmatterTags(frontmatter), ...map.tags])].sort(),
        stat: { ctime: snapshot.ctimeMs, mtime: snapshot.mtimeMs, size: snapshot.bytes.length },
        revision: revisionFromBytes(snapshot.bytes, snapshot.mtimeMs),
        links: map.links,
        embeds: map.embeds
      };
    });
  }

  async write(filePath: string, content: string, expectedSha256?: string): Promise<LocalFileMutationResult> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    return this.locks.withLock([relative], async () => {
      try {
        await this.guard.assertWritableParent(relative);
        const absolute = this.guard.resolveCreate(relative);
        const existing = await readFileIfExists(absolute);
        assertExpectedRevision(relative, existing, expectedSha256, "CONTENT_CONFLICT");
        await this.backupExisting(relative, "vault_write");
        await atomicWriteFile(absolute, content);
        const revision = await revisionForPath(absolute);
        await audit("vault_write", "success", { path: relative, bytes: Buffer.byteLength(content), sha256: revision.sha256 });
        return { path: relative, revision };
      } catch (error) {
        await audit("vault_write", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async createNote(filePath: string, content: string): Promise<LocalFileMutationResult> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    return this.locks.withLock([relative], async () => {
      try {
        await this.guard.assertWritableParent(relative);
        const absolute = this.guard.resolveCreate(relative);
        try {
          await atomicCreateFile(absolute, content);
        } catch (error) {
          if (nodeErrorCode(error) === "EEXIST") {
            throw new ToolDomainError("ALREADY_EXISTS", `note already exists: ${relative}`, {
              details: { path: relative },
              cause: error
            });
          }
          throw error;
        }
        const revision = await revisionForPath(absolute);
        await audit("vault_create_note", "success", { path: relative, bytes: Buffer.byteLength(content), sha256: revision.sha256 });
        return { path: relative, revision };
      } catch (error) {
        await audit("vault_create_note", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async replaceNote(filePath: string, content: string, expectedSha256: string): Promise<LocalFileMutationResult> {
    const relative = this.guard.validateFilePath(filePath);
    return this.locks.withLock([relative], async () => {
      try {
        const absolute = await this.guard.resolveExisting(relative);
        const existing = await readFile(absolute);
        assertExpectedRevision(relative, existing, expectedSha256, "CONTENT_CONFLICT");
        await this.backupExisting(relative, "vault_replace_note");
        await atomicWriteFile(absolute, content);
        const revision = await revisionForPath(absolute);
        await audit("vault_replace_note", "success", { path: relative, bytes: Buffer.byteLength(content), sha256: revision.sha256 });
        return { path: relative, revision };
      } catch (error) {
        await audit("vault_replace_note", "failure", { path: relative, error: errorMessage(error) });
        throw error;
      }
    });
  }

  async append(filePath: string, content: string, expectedSha256?: string): Promise<LocalFileMutationResult> {
    const relative = this.guard.validateFilePath(filePath, { allowMissing: true });
    return this.locks.withLock([relative], async () => {
      await this.guard.assertWritableParent(relative);
      const absolute = this.guard.resolveCreate(relative);
      const existingBytes = await readFileIfExists(absolute);
      assertExpectedRevision(relative, existingBytes, expectedSha256, "CONTENT_CONFLICT");
      const existing = existingBytes?.toString("utf8") ?? "";
      const next = existing.length === 0 ? content : `${existing.endsWith("\n") ? existing : `${existing}\n`}${content}`;
      try {
        await this.backupExisting(relative, "vault_append");
        await atomicWriteFile(absolute, next);
        const revision = await revisionForPath(absolute);
        await audit("vault_append", "success", { path: relative, bytes: Buffer.byteLength(content), sha256: revision.sha256 });
        return { path: relative, revision };
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

  async patch(filePath: string, args: PatchArgs, expectedSha256?: string): Promise<LocalFileMutationResult> {
    const relative = this.guard.validateFilePath(filePath);
    return this.locks.withLock([relative], async () => {
      try {
        const absolute = await this.guard.resolveExisting(relative);
        const bytes = await readFile(absolute);
        assertExpectedRevision(relative, bytes, expectedSha256, "CONTENT_CONFLICT");
        const content = bytes.toString("utf8");
        await this.backupExisting(relative, "vault_patch");
        await atomicWriteFile(absolute, patchMarkdown(content, args));
        const revision = await revisionForPath(absolute);
        await audit("vault_patch", "success", { path: relative, targetType: args.targetType, target: args.target, operation: args.operation, sha256: revision.sha256 });
        return { path: relative, revision };
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

  async delete(filePath: string, expectedSha256?: string): Promise<DeleteMutationResult> {
    const relative = this.guard.validateVaultPath(filePath);
    return this.locks.withLock([relative], async () => {
      let mutation: PendingMutation | undefined;
      let localApplied = false;
      let readyMarked = false;
      try {
        const existing = await this.guard.resolveExistingPath(relative);
        if (existing.type === "directory") {
          if (expectedSha256 !== undefined) {
            throw new ToolDomainError("INVALID_ARGUMENT", "expectedSha256 is only valid when deleting a file", {
              details: { path: relative }
            });
          }
          await rmdir(existing.absolute);
          await audit("vault_delete", "success", { path: relative, directory: true });
          return { path: relative };
        }
        const absolute = existing.absolute;
        const current = await readFile(absolute);
        assertExpectedRevision(relative, current, expectedSha256, "CONTENT_CONFLICT");
        await this.backupExisting(relative, "vault_delete");
        if (this.trashDelete) {
          const trashRelative = await this.allocateRecoveryPath(this.trashDir, relative, "vault_delete");
          const trashAbsolute = this.guard.resolveCreate(trashRelative);
          await mkdir(path.dirname(trashAbsolute), { recursive: true });
          mutation = await this.mutationJournal?.createDelete(relative);
          await rename(absolute, trashAbsolute);
          localApplied = true;
          await mutation?.markReady({ trashPath: trashRelative });
          readyMarked = mutation !== undefined;
          await audit("vault_delete", "success", { path: relative, trashPath: trashRelative, operationId: mutation?.id });
        } else {
          mutation = await this.mutationJournal?.createDelete(relative);
          await rm(absolute);
          localApplied = true;
          await mutation?.markReady();
          readyMarked = mutation !== undefined;
          await audit("vault_delete", "success", { path: relative, permanent: true, operationId: mutation?.id });
        }
        return mutation ? { path: relative, operationId: mutation.id } : { path: relative };
      } catch (error) {
        const failure = mutation
          ? await this.walMutationFailure(mutation, error, localApplied, readyMarked)
          : error;
        await audit("vault_delete", "failure", { path: relative, operationId: mutation?.id, error: errorMessage(failure) });
        throw failure;
      }
    });
  }

  async move(
    filePath: string,
    destination: string,
    allowOverwrite = false,
    expectedSha256?: string,
    expectedDestinationSha256?: string
  ): Promise<MoveMutationResult> {
    const sourceRelative = this.guard.validateVaultFilePath(filePath);
    const destinationRelative = this.guard.validateVaultDestination(destination, sourceRelative);
    const sourceIsMarkdown = sourceRelative.endsWith(".md");
    if (sourceIsMarkdown !== destinationRelative.endsWith(".md")) {
      throw new Error("vault_move cannot change a file between Markdown and non-Markdown extensions");
    }
    if (sourceRelative === destinationRelative) {
      throw new ToolDomainError("DESTINATION_CONFLICT", "source and destination must be different", {
        details: { path: sourceRelative, destination: destinationRelative }
      });
    }
    return this.locks.withLock([sourceRelative, destinationRelative], async () => {
      let mutation: PendingMutation | undefined;
      let localApplied = false;
      let readyMarked = false;
      try {
        const sourceAbsolute = await this.guard.resolveExisting(sourceRelative);
        const sourceBytes = await readFile(sourceAbsolute);
        assertExpectedRevision(sourceRelative, sourceBytes, expectedSha256, "CONTENT_CONFLICT");
        await this.guard.assertWritableParent(destinationRelative);
        const destinationAbsolute = this.guard.resolveCreate(destinationRelative);
        const destinationBytes = await readFileIfExists(destinationAbsolute);
        if (!allowOverwrite && destinationBytes !== undefined) {
          throw new ToolDomainError("DESTINATION_CONFLICT", `destination already exists: ${destinationRelative}`, {
            details: { destination: destinationRelative }
          });
        }
        if (expectedDestinationSha256 !== undefined && destinationBytes === undefined) {
          throw new ToolDomainError("DESTINATION_CONFLICT", `destination does not exist: ${destinationRelative}`, {
            details: { destination: destinationRelative, expectedSha256: expectedDestinationSha256, actualSha256: null }
          });
        }
        if (destinationBytes !== undefined) {
          assertExpectedRevision(destinationRelative, destinationBytes, expectedDestinationSha256, "DESTINATION_CONFLICT");
        }
        await this.backupExisting(sourceRelative, "vault_move");
        if (allowOverwrite && destinationBytes !== undefined) await this.backupExisting(destinationRelative, "vault_move_overwrite");
        mutation = await this.mutationJournal?.createMove(sourceRelative, destinationRelative, allowOverwrite);
        await rename(sourceAbsolute, destinationAbsolute);
        localApplied = true;
        await fsyncRenameParents(sourceAbsolute, destinationAbsolute);
        await mutation?.markReady();
        readyMarked = mutation !== undefined;
        await audit("vault_move", "success", { path: sourceRelative, destination: destinationRelative, allowOverwrite, operationId: mutation?.id });
        return mutation
          ? { oldPath: sourceRelative, newPath: destinationRelative, operationId: mutation.id }
          : { oldPath: sourceRelative, newPath: destinationRelative };
      } catch (error) {
        const failure = mutation
          ? await this.walMutationFailure(mutation, error, localApplied, readyMarked)
          : error;
        await audit("vault_move", "failure", { path: sourceRelative, destination: destinationRelative, allowOverwrite, operationId: mutation?.id, error: errorMessage(failure) });
        throw failure;
      }
    });
  }

  private async walMutationFailure(
    mutation: PendingMutation,
    error: unknown,
    localApplied: boolean,
    readyMarked: boolean
  ): Promise<ToolDomainError> {
    const message = errorMessage(error);
    if (readyMarked) {
      return new ToolDomainError("INTERNAL_ERROR", message, {
        cause: error,
        details: { operationId: mutation.id },
        result: {
          executionMode: "wal",
          operationId: mutation.id,
          status: "queued",
          outcome: "applied",
          commitLevel: "local"
        }
      });
    }
    if (!localApplied) {
      try {
        await mutation.cancel(message);
        return new ToolDomainError("INTERNAL_ERROR", message, {
          cause: error,
          details: { operationId: mutation.id },
          result: {
            executionMode: "wal",
            operationId: mutation.id,
            status: "cancelled",
            commitLevel: "none"
          }
        });
      } catch (cancelError) {
        return new ToolDomainError("INTERNAL_ERROR", "The local operation failed and its WAL record could not be cancelled.", {
          cause: error,
          details: { operationId: mutation.id, originalError: message, cancelError: errorMessage(cancelError) },
          result: {
            executionMode: "wal",
            operationId: mutation.id,
            status: "processing",
            commitLevel: "unknown",
            stateUncertain: true
          }
        });
      }
    }
    return new ToolDomainError("INTERNAL_ERROR", "The local operation may have completed, but its WAL state could not be finalized.", {
      cause: error,
      details: { operationId: mutation.id, originalError: message },
      result: {
        executionMode: "wal",
        operationId: mutation.id,
        status: "processing",
        commitLevel: "unknown",
        stateUncertain: true
      }
    });
  }

  async getOperation(operationId: string): Promise<OperationStatus> {
    if (!this.mutationJournal) {
      throw new ToolDomainError("PATH_NOT_FOUND", "operation journal is not configured", {
        details: { operationId }
      });
    }
    return this.mutationJournal.getOperation(operationId);
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

async function readSnapshot(filePath: string): Promise<{ bytes: Buffer; ctimeMs: number; mtimeMs: number }> {
  const handle = await open(filePath, "r");
  try {
    const bytes = await handle.readFile();
    const fileStat = await handle.stat();
    return { bytes, ctimeMs: fileStat.ctimeMs, mtimeMs: fileStat.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function readFileIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function revisionForPath(filePath: string): Promise<FileRevision> {
  const snapshot = await readSnapshot(filePath);
  return revisionFromBytes(snapshot.bytes, snapshot.mtimeMs);
}

function revisionFromBytes(bytes: Uint8Array, mtimeMs: number): FileRevision {
  return {
    sha256: sha256(bytes),
    size: bytes.byteLength,
    mtimeMs
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExpectedRevision(
  relative: string,
  currentBytes: Uint8Array | undefined,
  expectedSha256: string | undefined,
  code: "CONTENT_CONFLICT" | "DESTINATION_CONFLICT"
): void {
  if (expectedSha256 === undefined) return;
  const actualSha256 = currentBytes === undefined ? null : sha256(currentBytes);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new ToolDomainError(code, `file revision does not match: ${relative}`, {
      details: { path: relative, expectedSha256: expectedSha256.toLowerCase(), actualSha256 }
    });
  }
}

async function fsyncRenameParents(sourcePath: string, destinationPath: string): Promise<void> {
  const directories = [...new Set([path.dirname(sourcePath), path.dirname(destinationPath)])];
  for (const directory of directories) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
