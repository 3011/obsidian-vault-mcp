import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PathGuard } from "./pathGuard.js";
import { lineOffsets } from "../markdown/documentMap.js";

export type VaultWarning = {
  warningType: string;
  message: string;
  path?: string;
  notePath?: string;
  line?: number;
  raw?: string;
};

export type VaultEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  extension?: string;
  mime?: string;
  isAttachment: boolean;
  size?: number;
  mtime?: string;
  sha256?: string | null;
};

export type VaultListDetailedArgs = {
  path?: string;
  recursive?: boolean;
  includeSha256?: boolean;
};

export type VaultListDetailedResult = {
  path: string;
  exists: boolean | null;
  kind: "directory" | "file" | "missing" | "denied" | "unknown";
  isEmpty?: boolean;
  entryCount?: number;
  entries: VaultEntry[];
  excludedPaths: string[];
  warnings: VaultWarning[];
  generatedAt: string;
  scanId: string;
};

export type ScanCompleteness = "full_vault" | "scoped" | "partial" | "failed";
export type ReferenceType = "wikilink_embed" | "wikilink_link" | "markdown_image" | "html_img";
export type ReferenceResolution = "exact_path" | "relative_path" | "basename_unique" | "basename_ambiguous" | "unresolved" | "unsupported";
export type ReferenceConfidence = "high" | "medium" | "low";
export type TrashSafety = "safe" | "unsafe" | "unknown";

export type AssetReference = {
  notePath: string;
  line: number;
  raw: string;
  referenceType: ReferenceType;
  resolution: ReferenceResolution;
  confidence: ReferenceConfidence;
};

export type AssetReferenceResult = {
  assetPath: string;
  exists: boolean;
  basename: string;
  duplicateBasenameCount: number;
  referencedByCount: number;
  references: AssetReference[];
  ambiguous: boolean;
  unresolvedPotentialMatches: number;
  unsupportedPotentialMatches: number;
  candidateOrphan: boolean;
  trashSafety: TrashSafety;
  trashSafetyReason: string;
  trashSafetyEvidence: string[];
  warnings: VaultWarning[];
};

export type FindAssetReferencesArgs = {
  assetPaths: string[];
  scope?: string;
};

export type FindAssetReferencesResult = {
  scanId: string;
  generatedAt: string;
  scanCompleteness: ScanCompleteness;
  scanScope: string;
  excludedPaths: string[];
  parserCoverage: {
    supported: string[];
    unsupportedRecognized: string[];
    note: string;
  };
  results: AssetReferenceResult[];
  warnings: VaultWarning[];
};

export type AssetAuditArgs = {
  root: string;
  recursive?: boolean;
  scope?: string;
  includeSha256?: boolean;
};

export type AssetAuditItem = VaultEntry & {
  referencedByCount: number;
  references: AssetReference[];
  ambiguous: boolean;
  unresolvedPotentialMatches: number;
  unsupportedPotentialMatches: number;
  duplicateBasenameCount: number;
  candidateOrphan: boolean;
  trashSafety: TrashSafety;
  trashSafetyReason: string;
  trashSafetyEvidence: string[];
  warnings: VaultWarning[];
};

export type AssetAuditResult = {
  root: string;
  rootExists: boolean | null;
  rootKind: VaultListDetailedResult["kind"];
  rootEntryCount: number;
  scanId: string;
  generatedAt: string;
  scanCompleteness: ScanCompleteness;
  scanScope: string;
  excludedPaths: string[];
  summary: {
    totalAssets: number;
    referenced: number;
    candidateOrphans: number;
    safeToTrash: number;
    unsafe: number;
    unknown: number;
    ambiguous: number;
    warnings: number;
  };
  assets: AssetAuditItem[];
  warnings: VaultWarning[];
};

type ScanMeta = {
  scanId: string;
  generatedAt: string;
  scanCompleteness: ScanCompleteness;
  scanScope: string;
  excludedPaths: string[];
  warnings: VaultWarning[];
};

type ParsedReference = {
  notePath: string;
  noteDir: string;
  line: number;
  raw: string;
  referenceType: ReferenceType | "unsupported_html_attr";
  target: string;
};

const EXCLUDED_PATHS = [".obsidian/**", ".livesync/**", ".git/**", ".trash/**", ".backups/**", "node_modules/**"];
const SUPPORTED_REFERENCES = [
  "![[asset]]",
  "[[asset]]",
  "![[asset|alias]]",
  "![[asset#heading]]",
  "![[asset#heading|alias]]",
  "![alt](asset)",
  "<img src=\"asset\">"
];
const PARSER_NOTE = "This scan only covers supported Markdown/HTML asset reference forms. It may not detect custom plugin references, external system references, or unsupported syntaxes.";

export async function vaultListDetailed(guard: PathGuard, args: VaultListDetailedArgs): Promise<VaultListDetailedResult> {
  const generatedAt = new Date().toISOString();
  const scanId = newScanId(generatedAt);
  const warnings: VaultWarning[] = [];
  let relative: string;
  try {
    relative = guard.validateDirPath(args.path ?? "");
  } catch (error) {
    return {
      path: typeof args.path === "string" ? args.path : "",
      exists: null,
      kind: "denied",
      entries: [],
      excludedPaths: EXCLUDED_PATHS,
      warnings: [{ warningType: "path_denied", message: errorMessage(error), path: typeof args.path === "string" ? args.path : "" }],
      generatedAt,
      scanId
    };
  }
  if (isHiddenPath(relative)) {
    return {
      path: relative,
      exists: null,
      kind: "denied",
      entries: [],
      excludedPaths: EXCLUDED_PATHS,
      warnings: [{ warningType: "path_denied", message: "hidden paths are excluded from detailed listing", path: relative }],
      generatedAt,
      scanId
    };
  }

  const absolute = guard.resolveCreate(relative);
  let fileStat;
  try {
    fileStat = await lstat(absolute);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        path: relative,
        exists: false,
        kind: "missing",
        entries: [],
        excludedPaths: EXCLUDED_PATHS,
        warnings,
        generatedAt,
        scanId
      };
    }
    return {
      path: relative,
      exists: false,
      kind: "unknown",
      entries: [],
      excludedPaths: EXCLUDED_PATHS,
      warnings: [{ warningType: "stat_failed", message: errorMessage(error), path: relative }],
      generatedAt,
      scanId
    };
  }

  if (fileStat.isFile()) {
    const entry = await entryForFile(guard, relative, args.includeSha256 === true);
    return {
      path: relative,
      exists: true,
      kind: "file",
      entries: [entry],
      excludedPaths: EXCLUDED_PATHS,
      warnings,
      generatedAt,
      scanId
    };
  }

  if (!fileStat.isDirectory()) {
    return {
      path: relative,
      exists: true,
      kind: "unknown",
      entries: [],
      excludedPaths: EXCLUDED_PATHS,
      warnings: [{ warningType: "unsupported_path_kind", message: "path is not a regular file or directory", path: relative }],
      generatedAt,
      scanId
    };
  }

  const entries = await collectEntries(guard, relative, args.recursive === true, args.includeSha256 === true, warnings);
  return {
    path: relative,
    exists: true,
    kind: "directory",
    isEmpty: entries.length === 0,
    entryCount: entries.length,
    entries,
    excludedPaths: EXCLUDED_PATHS,
    warnings,
    generatedAt,
    scanId
  };
}

export async function findAssetReferences(guard: PathGuard, args: FindAssetReferencesArgs): Promise<FindAssetReferencesResult> {
  if (!Array.isArray(args.assetPaths) || args.assetPaths.length === 0) throw new Error("assetPaths must contain at least one path");
  const meta = scanMeta(args.scope);
  const assetPaths = args.assetPaths.map((assetPath) => guard.validateVaultFilePath(assetPath));
  const allAssets = await collectAllAssets(guard, meta.warnings);
  if (meta.warnings.length > 0 && meta.scanCompleteness === "full_vault") meta.scanCompleteness = "partial";
  const references = await scanMarkdownReferences(guard, meta.scanScope, meta.warnings);
  if (meta.warnings.length > 0 && meta.scanCompleteness === "full_vault") meta.scanCompleteness = "partial";
  const results = await buildReferenceResults(guard, assetPaths, allAssets, references, meta);
  return {
    scanId: meta.scanId,
    generatedAt: meta.generatedAt,
    scanCompleteness: meta.scanCompleteness,
    scanScope: meta.scanScope,
    excludedPaths: meta.excludedPaths,
    parserCoverage: {
      supported: SUPPORTED_REFERENCES,
      unsupportedRecognized: [],
      note: PARSER_NOTE
    },
    results,
    warnings: meta.warnings
  };
}

export async function assetAudit(guard: PathGuard, args: AssetAuditArgs): Promise<AssetAuditResult> {
  const listArgs: VaultListDetailedArgs = { path: args.root, recursive: args.recursive ?? true };
  if (args.includeSha256 != null) listArgs.includeSha256 = args.includeSha256;
  const list = await vaultListDetailed(guard, listArgs);
  const assets = list.entries.filter((entry) => entry.kind === "file" && entry.isAttachment);
  let references: FindAssetReferencesResult | undefined;
  if (assets.length > 0) {
    const referenceArgs: FindAssetReferencesArgs = { assetPaths: assets.map((entry) => entry.path) };
    if (args.scope != null) referenceArgs.scope = args.scope;
    references = await findAssetReferences(guard, referenceArgs);
  }
  const referenceByPath = new Map(references?.results.map((result) => [result.assetPath, result]) ?? []);
  const auditItems: AssetAuditItem[] = assets.map((entry) => {
    const result = referenceByPath.get(entry.path);
    return {
      ...entry,
      referencedByCount: result?.referencedByCount ?? 0,
      references: result?.references ?? [],
      ambiguous: result?.ambiguous ?? false,
      unresolvedPotentialMatches: result?.unresolvedPotentialMatches ?? 0,
      unsupportedPotentialMatches: result?.unsupportedPotentialMatches ?? 0,
      duplicateBasenameCount: result?.duplicateBasenameCount ?? 0,
      candidateOrphan: result?.candidateOrphan ?? true,
      trashSafety: result?.trashSafety ?? "unknown",
      trashSafetyReason: result?.trashSafetyReason ?? "no_reference_scan_performed",
      trashSafetyEvidence: result?.trashSafetyEvidence ?? [],
      warnings: result?.warnings ?? []
    };
  });
  const warnings = [...list.warnings, ...(references?.warnings ?? [])];
  const generatedAt = references?.generatedAt ?? list.generatedAt;
  const scanId = references?.scanId ?? list.scanId;
  const scanCompleteness = references?.scanCompleteness ?? (args.scope ? "scoped" : "full_vault");
  const scanScope = references?.scanScope ?? normalizeScope(args.scope);
  return {
    root: list.path,
    rootExists: list.exists,
    rootKind: list.kind,
    rootEntryCount: list.entryCount ?? list.entries.length,
    scanId,
    generatedAt,
    scanCompleteness,
    scanScope,
    excludedPaths: EXCLUDED_PATHS,
    summary: {
      totalAssets: auditItems.length,
      referenced: auditItems.filter((item) => item.referencedByCount > 0).length,
      candidateOrphans: auditItems.filter((item) => item.candidateOrphan).length,
      safeToTrash: auditItems.filter((item) => item.trashSafety === "safe").length,
      unsafe: auditItems.filter((item) => item.trashSafety === "unsafe").length,
      unknown: auditItems.filter((item) => item.trashSafety === "unknown").length,
      ambiguous: auditItems.filter((item) => item.ambiguous).length,
      warnings: warnings.length + auditItems.reduce((sum, item) => sum + item.warnings.length, 0)
    },
    assets: auditItems,
    warnings
  };
}

async function collectEntries(guard: PathGuard, dir: string, recursive: boolean, includeSha256: boolean, warnings: VaultWarning[]): Promise<VaultEntry[]> {
  let dirents;
  try {
    dirents = await readdir(guard.resolveCreate(dir), { withFileTypes: true });
  } catch (error) {
    warnings.push({ warningType: "readdir_failed", message: errorMessage(error), path: dir });
    return [];
  }
  const entries: VaultEntry[] = [];
  for (const dirent of dirents) {
    const relative = dir ? `${dir}/${dirent.name}` : dirent.name;
    if (isHiddenPath(relative)) continue;
    try {
      if (dirent.isDirectory()) {
        const directoryPath = guard.validateDirPath(relative);
        entries.push({
          name: dirent.name,
          path: directoryPath,
          kind: "directory",
          isAttachment: false
        });
        if (recursive) entries.push(...await collectEntries(guard, directoryPath, true, includeSha256, warnings));
      } else if (dirent.isFile()) {
        entries.push(await entryForFile(guard, guard.validateVaultFilePath(relative), includeSha256));
      }
    } catch (error) {
      warnings.push({ warningType: "entry_skipped", message: errorMessage(error), path: relative });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function entryForFile(guard: PathGuard, relative: string, includeSha256: boolean): Promise<VaultEntry> {
  const fileStat = await stat(guard.resolveCreate(relative));
  const extension = path.posix.extname(relative).toLowerCase();
  return {
    name: path.posix.basename(relative),
    path: relative,
    kind: "file",
    extension,
    mime: mimeForPath(relative),
    isAttachment: isAttachmentPath(relative),
    size: fileStat.size,
    mtime: fileStat.mtime.toISOString(),
    sha256: includeSha256 ? await sha256File(guard.resolveCreate(relative)) : null
  };
}

async function collectAllAssets(guard: PathGuard, warnings: VaultWarning[]): Promise<VaultEntry[]> {
  const entries = await collectEntries(guard, "", true, false, warnings);
  return entries.filter((entry) => entry.kind === "file" && entry.isAttachment);
}

async function scanMarkdownReferences(guard: PathGuard, scope: string, warnings: VaultWarning[]): Promise<ParsedReference[]> {
  const references: ParsedReference[] = [];
  for await (const notePath of walkMarkdown(guard, scope, warnings)) {
    let content: string;
    try {
      content = await readFile(guard.resolveCreate(notePath), "utf8");
    } catch (error) {
      warnings.push({ warningType: "read_failed", message: errorMessage(error), path: notePath });
      continue;
    }
    references.push(...parseReferences(notePath, content));
  }
  return references;
}

async function* walkMarkdown(guard: PathGuard, dir: string, warnings: VaultWarning[]): AsyncGenerator<string> {
  let pathStat;
  try {
    pathStat = await lstat(guard.resolveCreate(dir));
  } catch (error) {
    warnings.push({ warningType: "stat_failed", message: errorMessage(error), path: dir });
    return;
  }
  if (pathStat.isFile()) {
    try {
      yield guard.validateFilePath(dir);
    } catch (error) {
      warnings.push({ warningType: "scope_not_markdown", message: errorMessage(error), path: dir });
    }
    return;
  }
  if (!pathStat.isDirectory()) {
    warnings.push({ warningType: "unsupported_scope_kind", message: "scope is not a regular Markdown file or directory", path: dir });
    return;
  }
  let entries;
  try {
    entries = await readdir(guard.resolveCreate(dir), { withFileTypes: true });
  } catch (error) {
    warnings.push({ warningType: "readdir_failed", message: errorMessage(error), path: dir });
    return;
  }
  for (const entry of entries) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (isHiddenPath(relative)) continue;
    try {
      if (entry.isDirectory()) {
        yield* walkMarkdown(guard, guard.validateDirPath(relative), warnings);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        yield guard.validateFilePath(relative);
      }
    } catch (error) {
      warnings.push({ warningType: "entry_skipped", message: errorMessage(error), path: relative });
    }
  }
}

function parseReferences(notePath: string, content: string): ParsedReference[] {
  const references: ParsedReference[] = [];
  const noteDir = path.posix.dirname(notePath) === "." ? "" : path.posix.dirname(notePath);
  let inFence = false;
  for (const record of lineOffsets(content)) {
    const rawLine = record.text.replace(/\r?\n$/, "");
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = stripInlineCode(rawLine);
    for (const match of line.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      const raw = match[0];
      const target = parseWikilinkTarget(match[2] ?? "");
      if (!raw || !target) continue;
      references.push({
        notePath,
        noteDir,
        line: lineNumberFromRecord(content, record.start),
        raw,
        referenceType: match[1] === "!" ? "wikilink_embed" : "wikilink_link",
        target
      });
    }
    for (const match of line.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
      const raw = match[0];
      const target = parseMarkdownImageTarget(match[1] ?? "");
      if (!raw || !target) continue;
      references.push({ notePath, noteDir, line: lineNumberFromRecord(content, record.start), raw, referenceType: "markdown_image", target });
    }
    for (const match of line.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
      const raw = match[0];
      const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!raw || !target || isExternalReferenceTarget(target)) continue;
      references.push({ notePath, noteDir, line: lineNumberFromRecord(content, record.start), raw, referenceType: "html_img", target });
    }
    for (const match of line.matchAll(/<([a-z][\w:-]*)\b[^>]*\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
      const tag = (match[1] ?? "").toLowerCase();
      const raw = match[0];
      const target = (match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (tag === "img" || !raw || !target || isExternalReferenceTarget(target)) continue;
      references.push({ notePath, noteDir, line: lineNumberFromRecord(content, record.start), raw, referenceType: "unsupported_html_attr", target });
    }
  }
  return references;
}

async function buildReferenceResults(guard: PathGuard, assetPaths: string[], allAssets: VaultEntry[], references: ParsedReference[], meta: ScanMeta): Promise<AssetReferenceResult[]> {
  const assetsByPath = new Map(allAssets.map((asset) => [asset.path, asset]));
  const assetsByBasename = new Map<string, VaultEntry[]>();
  const assetsByLowerBasename = new Map<string, VaultEntry[]>();
  for (const asset of allAssets) {
    addMapArray(assetsByBasename, asset.name, asset);
    addMapArray(assetsByLowerBasename, asset.name.toLowerCase(), asset);
  }
  const resultMap = new Map<string, AssetReferenceResult>();
  for (const assetPath of assetPaths) {
    const basename = path.posix.basename(assetPath);
    const duplicateBasenameCount = assetsByBasename.get(basename)?.length ?? 0;
    const exists = await regularFileExists(guard, assetPath);
    const initial = emptyReferenceResult(assetPath, exists, basename, duplicateBasenameCount);
    resultMap.set(assetPath, initial);
  }

  for (const reference of references) {
    const normalizedTarget = normalizeReferenceTarget(reference.target);
    if (!normalizedTarget) continue;
    const matched = resolveReference(reference, normalizedTarget, assetsByPath, assetsByBasename, assetsByLowerBasename);
    for (const assetPath of assetPaths) {
      const result = resultMap.get(assetPath);
      if (!result) continue;
      const match = matched.find((item) => item.assetPath === assetPath);
      if (reference.referenceType === "unsupported_html_attr") {
        if (match || isPotentialTargetMatch(assetPath, normalizedTarget)) {
          result.unsupportedPotentialMatches += 1;
          result.warnings.push({
            warningType: "unsupported_potential_match",
            message: "An unsupported src/href reference may point to this asset.",
            path: assetPath,
            notePath: reference.notePath,
            line: reference.line,
            raw: reference.raw
          });
        }
        continue;
      }
      if (match) {
        result.references.push({
          notePath: reference.notePath,
          line: reference.line,
          raw: reference.raw,
          referenceType: reference.referenceType,
          resolution: match.resolution,
          confidence: match.confidence
        });
        if (match.resolution === "basename_ambiguous") result.ambiguous = true;
        if (match.resolution === "unresolved") {
          result.unresolvedPotentialMatches += 1;
          result.warnings.push({
            warningType: "unresolved_potential_match",
            message: "A case-mismatched reference may point to this asset.",
            path: assetPath,
            notePath: reference.notePath,
            line: reference.line,
            raw: reference.raw
          });
        }
        if (match.resolution === "unsupported") {
          result.unsupportedPotentialMatches += 1;
          result.warnings.push({
            warningType: "unsupported_potential_match",
            message: "An unsupported reference may point to this asset.",
            path: assetPath,
            notePath: reference.notePath,
            line: reference.line,
            raw: reference.raw
          });
        }
      } else if (isPotentialTargetMatch(assetPath, normalizedTarget)) {
        result.unresolvedPotentialMatches += 1;
        result.warnings.push({
          warningType: "unresolved_potential_match",
          message: "An unresolved or case-mismatched reference may point to this asset.",
          path: assetPath,
          notePath: reference.notePath,
          line: reference.line,
          raw: reference.raw
        });
      }
    }
  }

  return [...resultMap.values()].map((result) => finalizeTrashSafety(result, meta));
}

function resolveReference(
  reference: ParsedReference,
  target: string,
  assetsByPath: Map<string, VaultEntry>,
  assetsByBasename: Map<string, VaultEntry[]>,
  assetsByLowerBasename: Map<string, VaultEntry[]>
): Array<{ assetPath: string; resolution: ReferenceResolution; confidence: ReferenceConfidence }> {
  const matches: Array<{ assetPath: string; resolution: ReferenceResolution; confidence: ReferenceConfidence }> = [];
  const hasPath = target.includes("/");
  const exact = assetsByPath.get(target);
  if (exact) matches.push({ assetPath: exact.path, resolution: "exact_path", confidence: "high" });
  if (hasPath) {
    const relative = path.posix.normalize(`${reference.noteDir}/${target}`).replace(/^\.?\//, "");
    const relativeAsset = assetsByPath.get(relative);
    if (relativeAsset && relativeAsset.path !== exact?.path) matches.push({ assetPath: relativeAsset.path, resolution: "relative_path", confidence: "high" });
  } else {
    const candidates = assetsByBasename.get(path.posix.basename(target)) ?? [];
    if (candidates.length === 1) matches.push({ assetPath: candidates[0]!.path, resolution: "basename_unique", confidence: "high" });
    else if (candidates.length > 1) {
      for (const candidate of candidates) matches.push({ assetPath: candidate.path, resolution: "basename_ambiguous", confidence: "low" });
    }
  }
  if (matches.length === 0) {
    const lowerCandidates = assetsByLowerBasename.get(path.posix.basename(target).toLowerCase()) ?? [];
    for (const candidate of lowerCandidates) matches.push({ assetPath: candidate.path, resolution: "unresolved", confidence: "low" });
  }
  return dedupeMatches(matches);
}

function emptyReferenceResult(assetPath: string, exists: boolean, basename: string, duplicateBasenameCount: number): AssetReferenceResult {
  return {
    assetPath,
    exists,
    basename,
    duplicateBasenameCount,
    referencedByCount: 0,
    references: [],
    ambiguous: false,
    unresolvedPotentialMatches: 0,
    unsupportedPotentialMatches: 0,
    candidateOrphan: true,
    trashSafety: "unknown",
    trashSafetyReason: "not_evaluated",
    trashSafetyEvidence: [],
    warnings: []
  };
}

function finalizeTrashSafety(result: AssetReferenceResult, meta: ScanMeta): AssetReferenceResult {
  result.referencedByCount = result.references.filter((reference) => reference.resolution !== "unresolved" && reference.resolution !== "unsupported").length;
  result.candidateOrphan = result.referencedByCount === 0;
  const confidentReferenceCount = result.references.filter((reference) => reference.resolution === "exact_path" || reference.resolution === "relative_path" || reference.resolution === "basename_unique").length;
  const evidence = [
    `assetExists=${result.exists}`,
    `scanCompleteness=${meta.scanCompleteness}`,
    `referencedByCount=${result.referencedByCount}`,
    `confidentReferenceCount=${confidentReferenceCount}`,
    `ambiguous=${result.ambiguous}`,
    `unresolvedPotentialMatches=${result.unresolvedPotentialMatches}`,
    `unsupportedPotentialMatches=${result.unsupportedPotentialMatches}`,
    `duplicateBasenameCount=${result.duplicateBasenameCount}`,
    `warnings=${result.warnings.length}`
  ];
  result.trashSafetyEvidence = evidence;
  if (!result.exists) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "asset_path_does_not_exist";
  } else if (confidentReferenceCount > 0) {
    result.trashSafety = "unsafe";
    result.trashSafetyReason = "referenced_by_markdown";
  } else if (meta.scanCompleteness !== "full_vault") {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "scan_is_not_full_vault";
  } else if (result.ambiguous) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "ambiguous_basename_reference";
  } else if (result.unresolvedPotentialMatches > 0) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "unresolved_reference_may_match_asset";
  } else if (result.unsupportedPotentialMatches > 0) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "unsupported_potential_reference";
  } else if (result.duplicateBasenameCount > 1) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "duplicate_basename_exists";
  } else if (result.warnings.length > 0 || meta.warnings.length > 0) {
    result.trashSafety = "unknown";
    result.trashSafetyReason = "scan_warnings_present";
  } else {
    result.trashSafety = "safe";
    result.trashSafetyReason = "no_structured_references_found_full_vault";
  }
  return result;
}

function scanMeta(scope: string | undefined): ScanMeta {
  const generatedAt = new Date().toISOString();
  const scanScope = normalizeScope(scope);
  return {
    scanId: newScanId(generatedAt),
    generatedAt,
    scanCompleteness: scanScope ? "scoped" : "full_vault",
    scanScope,
    excludedPaths: EXCLUDED_PATHS,
    warnings: []
  };
}

function normalizeScope(scope: string | undefined): string {
  if (!scope || scope === "/") return "";
  return scope.replace(/^\/+|\/+$/g, "");
}

function parseWikilinkTarget(raw: string): string {
  const withoutAlias = raw.split("|")[0] ?? "";
  const withoutHeading = withoutAlias.split("#")[0] ?? "";
  return withoutHeading.trim();
}

function parseMarkdownImageTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end >= 0 ? trimmed.slice(1, end).trim() : "";
  }
  const titleMatch = trimmed.match(/^(.+?)(?:\s+["'][^"']*["'])$/);
  return (titleMatch?.[1] ?? trimmed).trim();
}

function normalizeReferenceTarget(raw: string): string {
  const withoutQuery = raw.split("?")[0] ?? raw;
  const withoutHash = withoutQuery.split("#")[0] ?? withoutQuery;
  const decoded = safeDecodeURIComponent(withoutHash);
  return path.posix.normalize(decoded.replaceAll("\\", "/")).replace(/^\.?\//, "").replace(/^\/+/, "");
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
}

function lineNumberFromRecord(markdown: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < markdown.length; index += 1) {
    if (markdown[index] === "\n") line += 1;
  }
  return line;
}

function isPotentialTargetMatch(assetPath: string, target: string): boolean {
  const assetBase = path.posix.basename(assetPath);
  const targetBase = path.posix.basename(target);
  return assetBase.toLowerCase() === targetBase.toLowerCase();
}

function isAttachmentPath(relative: string): boolean {
  return path.posix.extname(relative).toLowerCase() !== ".md";
}

function isHiddenPath(relative: string): boolean {
  return relative.split("/").some((part) => part.startsWith("."));
}

function mimeForPath(relative: string): string {
  const ext = path.posix.extname(relative).toLowerCase();
  const mimes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv"
  };
  return mimes[ext] ?? "application/octet-stream";
}

async function regularFileExists(guard: PathGuard, relative: string): Promise<boolean> {
  try {
    const fileStat = await lstat(guard.resolveCreate(relative));
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function sha256File(absolute: string): Promise<string> {
  const content = await readFile(absolute);
  return createHash("sha256").update(content).digest("hex");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isExternalReferenceTarget(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function addMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function dedupeMatches(matches: Array<{ assetPath: string; resolution: ReferenceResolution; confidence: ReferenceConfidence }>): Array<{ assetPath: string; resolution: ReferenceResolution; confidence: ReferenceConfidence }> {
  const seen = new Set<string>();
  const deduped: Array<{ assetPath: string; resolution: ReferenceResolution; confidence: ReferenceConfidence }> = [];
  for (const match of matches) {
    const key = `${match.assetPath}:${match.resolution}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function newScanId(generatedAt: string): string {
  return `scan_${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
