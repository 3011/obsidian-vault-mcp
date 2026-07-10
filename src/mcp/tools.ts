import { config } from "../config.js";
import { FsVault } from "../vault/FsVault.js";
import type { Tool } from "./types.js";

const mdPath = { type: "string", description: "Vault-relative Markdown note path ending in .md. The parent directory must already exist; writes to the vault root, absolute paths, and traversal are rejected." };
const vaultPath = { type: "string", description: "Vault-relative file path. Absolute paths and traversal are rejected." };

export function buildTools(vault: FsVault): Tool[] {
  const imageIntegrityRequired = config.imageAssetIntegrityMode === "required";
  const imageAssetRequiredFields = [
    "filename",
    "mimeType",
    "contentBase64",
    ...(imageIntegrityRequired ? ["expectedSha256", "expectedSize"] : [])
  ];
  const expectedSha256Description = imageIntegrityRequired
    ? "Required expected SHA-256 of the original decoded image bytes."
    : "Optional expected SHA-256 of the original decoded image bytes. Recommended for lossless/original preservation.";
  const expectedSizeDescription = imageIntegrityRequired
    ? "Required expected decoded image byte size."
    : "Optional expected decoded image byte size. Recommended with expectedSha256 for lossless/original preservation.";
  const integrityModeDescription = imageIntegrityRequired
    ? "The server is configured in required integrity mode, so expectedSha256 and expectedSize must be provided for every image."
    : "Integrity fields are optional unless preserveOriginal requires them under the configured integrity mode.";

  const tools: Tool[] = [
    {
      name: "vault_list",
      title: "Vault List",
      description: "List regular files and subdirectories inside a vault directory, including Markdown notes and attachments such as images. Directory entries end with '/'.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Vault-relative directory path to list. Omit or pass an empty string for the vault root." } },
        additionalProperties: false
      },
      handler: async (args) => ({ files: await vault.list(String(args.path ?? "")) })
    },
    {
      name: "vault_list_detailed",
      title: "Vault List Detailed",
      description: "Return structured facts for a vault path without modifying anything. Distinguishes missing paths, files, empty directories, non-empty directories, denied paths, and skipped entries; includes attachment metadata.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file or directory path. Omit or pass an empty string for the vault root." },
          recursive: { type: "boolean", default: false, description: "Set true to list nested entries recursively." },
          includeSha256: { type: "boolean", default: false, description: "Set true to compute SHA-256 for files. This may add IO cost for large attachments." }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        const input: Parameters<FsVault["listDetailed"]>[0] = {};
        if (typeof args.path === "string") input.path = args.path;
        if (typeof args.recursive === "boolean") input.recursive = args.recursive;
        if (typeof args.includeSha256 === "boolean") input.includeSha256 = args.includeSha256;
        return vault.listDetailed(input);
      }
    },
    {
      name: "vault_read",
      title: "Vault Read",
      description: "Read a Markdown note with metadata, or read a supported non-Markdown text file. Binary files and targeted reads on non-Markdown files are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          path: vaultPath,
          targetType: { type: "string", enum: ["heading", "block", "frontmatter"], description: "Optional Markdown-only target kind to read instead of the whole note." },
          target: { type: "string", description: "Heading text, block ID, or frontmatter key to read when targetType is set." },
          targetDelimiter: { type: "string", default: "::", description: "Delimiter used when reading frontmatter-like inline fields." }
        },
        required: ["path"],
        additionalProperties: false
      },
      handler: async (args) => {
        const options: { targetType?: string; target?: string; targetDelimiter?: string } = {};
        if (typeof args.targetType === "string") options.targetType = args.targetType;
        if (typeof args.target === "string") options.target = args.target;
        if (typeof args.targetDelimiter === "string") options.targetDelimiter = args.targetDelimiter;
        return vault.read(String(args.path), options);
      }
    },
    {
      name: "vault_write",
      title: "Vault Write",
      description: "Create or overwrite a Markdown note inside an existing directory. Before writing, inspect the current directory structure with vault_list or vault_list_detailed and reuse a suitable directory. If no suitable directory exists, call vault_create_directory first. This tool never creates directories implicitly.",
      inputSchema: {
        type: "object",
        properties: { path: mdPath, content: { type: "string", description: "Full Markdown content." } },
        required: ["path", "content"],
        additionalProperties: false
      },
      handler: async (args) => {
        await vault.write(String(args.path), String(args.content ?? ""));
        return { message: "OK" };
      }
    },
    {
      name: "vault_append",
      title: "Vault Append",
      description: "Append Markdown content to a note, creating the Markdown file if missing. Inspect existing directories first and reuse a suitable one; if none exists, call vault_create_directory. Its parent directory must already exist and this tool never creates directories implicitly.",
      inputSchema: {
        type: "object",
        properties: { path: mdPath, content: { type: "string", description: "Markdown content to append." } },
        required: ["path", "content"],
        additionalProperties: false
      },
      handler: async (args) => {
        await vault.append(String(args.path), String(args.content ?? ""));
        return { message: "OK" };
      }
    },
    {
      name: "vault_create_directory",
      title: "Vault Create Directory",
      description: "Create exactly one new vault directory after inspecting the existing directory structure and determining that no suitable directory exists. The parent directory must already exist unless creating a new top-level directory, and nested paths must be created one level at a time. The reason must explain why existing directories are unsuitable and what the new directory will contain.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Existing vault-relative parent directory. Use an empty string to create a new top-level directory." },
          name: { type: "string", minLength: 1, maxLength: 200, description: "Single directory name only; slashes are rejected." },
          reason: { type: "string", minLength: 1, maxLength: 1000, description: "Why no existing directory is suitable and what content belongs in the new directory." }
        },
        required: ["parent", "name", "reason"],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = await vault.createDirectory(String(args.parent ?? ""), String(args.name ?? ""), String(args.reason ?? ""));
        return { message: "OK", ...result };
      }
    },
    {
      name: "vault_patch",
      title: "Vault Patch",
      description: "Patch a Markdown note heading, block reference, or frontmatter field with replace, prepend, or append.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          targetType: { type: "string", enum: ["heading", "block", "frontmatter"], description: "Markdown target kind to patch." },
          target: { type: "string", description: "Heading text, block ID, or frontmatter key to patch." },
          operation: { type: "string", enum: ["replace", "prepend", "append"], description: "How to apply content to the selected target." },
          content: { description: "Replacement or inserted content. Use a JSON value with contentType application/json for frontmatter patches." },
          contentType: { type: "string", enum: ["text/markdown", "application/json"], description: "Content interpretation. Defaults to Markdown/text behavior when omitted." },
          createTargetIfMissing: { type: "boolean", description: "Create the heading, block, or frontmatter key when it does not exist." },
          trimTargetWhitespace: { type: "boolean", description: "Trim whitespace around the existing target content before patching." },
          rejectIfContentPreexists: { type: "boolean", description: "Reject the patch if the exact content is already present in the target." },
          targetDelimiter: { type: "string", default: "::", description: "Delimiter used for frontmatter-like inline fields." },
          targetScope: { type: "string", enum: ["content", "marker", "markerAndContent"], default: "content", description: "For block targets, choose whether to patch content, the marker line, or both." }
        },
        required: ["path", "targetType", "target", "operation", "content"],
        additionalProperties: false
      },
      handler: async (args) => {
        const patchArgs = {
          targetType: args.targetType as "heading" | "block" | "frontmatter",
          target: String(args.target),
          operation: args.operation as "replace" | "prepend" | "append",
          content: args.content,
          createTargetIfMissing: Boolean(args.createTargetIfMissing),
          trimTargetWhitespace: Boolean(args.trimTargetWhitespace),
          rejectIfContentPreexists: Boolean(args.rejectIfContentPreexists)
        } as {
          targetType: "heading" | "block" | "frontmatter";
          target: string;
          operation: "replace" | "prepend" | "append";
          content: unknown;
          contentType?: string;
          createTargetIfMissing?: boolean;
          trimTargetWhitespace?: boolean;
          rejectIfContentPreexists?: boolean;
          targetDelimiter?: string;
          targetScope?: "content" | "marker" | "markerAndContent";
        };
        if (typeof args.contentType === "string") patchArgs.contentType = args.contentType;
        if (typeof args.targetDelimiter === "string") patchArgs.targetDelimiter = args.targetDelimiter;
        if (args.targetScope === "content" || args.targetScope === "marker" || args.targetScope === "markerAndContent") {
          patchArgs.targetScope = args.targetScope;
        }
        await vault.patch(String(args.path), patchArgs);
        return { message: "OK" };
      }
    },
    {
      name: "vault_delete",
      title: "Vault Delete",
      description: "Delete a vault file, including attachments, or delete an empty directory. Non-empty directories are rejected.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Vault-relative file path, attachment path, or empty directory path. Non-empty directories are rejected." } },
        required: ["path"],
        additionalProperties: false
      },
      handler: async (args) => {
        await vault.delete(String(args.path));
        return { message: "OK" };
      }
    },
    {
      name: "vault_move",
      title: "Vault Move",
      description: "Move or rename a vault file into an existing destination directory. This tool never creates directories. If destination ends with '/', the original filename is preserved. Markdown files cannot be renamed to non-Markdown paths, or vice versa.",
      inputSchema: {
        type: "object",
        properties: {
          path: vaultPath,
          destination: { type: "string", description: "Destination vault-relative file path, or a directory ending with '/' to preserve the original filename." },
          allowOverwrite: { type: "boolean", default: false, description: "Set true to replace an existing destination file." }
        },
        required: ["path", "destination"],
        additionalProperties: false
      },
      handler: async (args) => {
        const newPath = await vault.move(String(args.path), String(args.destination), Boolean(args.allowOverwrite));
        return { message: "OK", oldPath: args.path, newPath };
      }
    },
    {
      name: "vault_get_document_map",
      title: "Vault Get Document Map",
      description: "Return headings, block references, frontmatter fields, links, embeds, and tags for a Markdown note.",
      inputSchema: {
        type: "object",
        properties: { path: mdPath },
        required: ["path"],
        additionalProperties: false
      },
      handler: async (args) => vault.documentMap(String(args.path))
    },
    {
      name: "search_simple",
      title: "Search Simple",
      description: "Search Markdown note paths and contents with a case-insensitive substring search, returning snippets with context.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring to search for in Markdown paths and note contents." },
          contextLength: { type: "number", default: 100, description: "Approximate number of characters to include around each content match." },
          limit: { type: "number", default: 100, description: "Maximum number of matches to return." }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args) => vault.searchSimple(String(args.query), Number(args.contextLength ?? 100), Number(args.limit ?? 100))
    },
    {
      name: "search_query",
      title: "Search Query",
      description: "Search Markdown notes with structured filters for path glob, tag, frontmatter equality, and content substring. All provided filters are combined with AND.",
      inputSchema: {
        type: "object",
        properties: {
          pathGlob: { type: "string", description: "Optional glob for vault-relative Markdown paths, for example 98-Inbox/** or **/project-*.md." },
          tag: { type: "string", description: "Optional tag filter, with or without leading #." },
          frontmatter: { type: "object", description: "Optional frontmatter equality filters, matched by key and JSON-equivalent value.", additionalProperties: true },
          content: { type: "string", description: "Optional case-insensitive substring to match in note content." },
          limit: { type: "number", default: 100, description: "Maximum number of matching notes to return." }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        const query: Parameters<FsVault["searchQuery"]>[0] = {};
        if (typeof args.pathGlob === "string") query.pathGlob = args.pathGlob;
        if (typeof args.tag === "string") query.tag = args.tag;
        if (args.frontmatter && typeof args.frontmatter === "object" && !Array.isArray(args.frontmatter)) query.frontmatter = args.frontmatter as Record<string, unknown>;
        if (typeof args.content === "string") query.content = args.content;
        if (typeof args.limit === "number") query.limit = args.limit;
        return vault.searchQuery(query);
      }
    },
    {
      name: "find_asset_references",
      title: "Find Asset References",
      description: "Read-only, conservative asset reference analysis for one or more vault-relative asset paths. Returns evidence, ambiguity, and trashSafety; when the server cannot confidently determine an asset is unused, trashSafety is 'unknown' rather than 'safe'.",
      inputSchema: {
        type: "object",
        properties: {
          assetPaths: {
            type: "array",
            description: "Vault-relative asset paths to analyze. Use an array even when checking one asset.",
            items: vaultPath,
            minItems: 1
          },
          scope: { type: "string", description: "Optional vault-relative directory scope for Markdown scanning. Scoped scans can never return trashSafety='safe'." }
        },
        required: ["assetPaths"],
        additionalProperties: false
      },
      handler: async (args) => {
        const input: Parameters<FsVault["findAssetReferences"]>[0] = { assetPaths: parseStringArray(args.assetPaths, "assetPaths") };
        if (typeof args.scope === "string") input.scope = args.scope;
        return vault.findAssetReferences(input);
      }
    },
    {
      name: "asset_audit",
      title: "Asset Audit",
      description: "Read-only asset audit for a vault directory. Combines detailed listing with conservative reference analysis; it does not move, delete, or rewrite files. candidateOrphan means no structured reference was found in the scan, while trashSafety is the stricter safe/unsafe/unknown server judgment.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Vault-relative directory containing assets to audit." },
          recursive: { type: "boolean", default: true, description: "Set true to audit nested assets under root." },
          scope: { type: "string", description: "Optional vault-relative directory scope for Markdown reference scanning. Scoped scans can never return trashSafety='safe'." },
          includeSha256: { type: "boolean", default: false, description: "Set true to compute SHA-256 for audited assets. This may add IO cost for large attachments." }
        },
        required: ["root"],
        additionalProperties: false
      },
      handler: async (args) => {
        const input: Parameters<FsVault["assetAudit"]>[0] = { root: String(args.root ?? "") };
        if (typeof args.recursive === "boolean") input.recursive = args.recursive;
        if (typeof args.scope === "string") input.scope = args.scope;
        if (typeof args.includeSha256 === "boolean") input.includeSha256 = args.includeSha256;
        return vault.assetAudit(input);
      }
    },
    {
      name: "tag_list",
      title: "Tag List",
      description: "List all tags across Markdown notes with usage counts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ tags: await vault.tagList() })
    },
    {
      name: "append_to_inbox",
      title: "Append To Inbox",
      description: "Append Markdown content to a note under the configured default inbox directory. Prefer inspecting existing directories and creating a justified directory with vault_create_directory when the content has a clear long-term category. Use this inbox tool for quick capture or genuinely unclassified material; the inbox directory must already exist.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Inbox note title or filename. If omitted, the default inbox note name is used." },
          content: { type: "string", description: "Markdown content to append." }
        },
        required: ["content"],
        additionalProperties: false
      },
      handler: async (args) => {
        const path = await vault.appendInbox(String(args.title ?? ""), String(args.content ?? ""));
        return { message: "OK", path };
      }
    },
    {
      name: "vault_upload_image_asset",
      title: "Vault Upload Image Asset",
      description: `Upload a small image asset into an existing vault assets directory and return an Obsidian embed link. This tool never creates asset directories. Only image MIME types are accepted. ${integrityModeDescription}`,
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Original image filename. The extension must match the MIME type." },
          mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"], description: "Image MIME type for the decoded bytes." },
          contentBase64: { type: "string", description: "Base64-encoded image bytes." },
          expectedSha256: { type: "string", description: expectedSha256Description },
          expectedSize: { type: "integer", minimum: 1, description: expectedSizeDescription },
          preserveOriginal: { type: "boolean", description: "Set true when the upload must preserve original bytes; this requires expectedSha256 and expectedSize in the default integrity mode." },
          dir: { type: "string", description: "Optional vault-relative asset directory. Defaults to the inbox assets directory and must be an allowed assets path." }
        },
        required: imageAssetRequiredFields,
        additionalProperties: false
      },
      handler: async (args) => {
        const input: { filename: string; mimeType: string; contentBase64: string; expectedSha256?: string; expectedSize?: number; preserveOriginal?: boolean; dir?: string } = {
          filename: String(args.filename ?? ""),
          mimeType: String(args.mimeType ?? ""),
          contentBase64: String(args.contentBase64 ?? "")
        };
        if (typeof args.expectedSha256 === "string") input.expectedSha256 = args.expectedSha256;
        if (typeof args.expectedSize === "number") input.expectedSize = args.expectedSize;
        if (typeof args.preserveOriginal === "boolean") input.preserveOriginal = args.preserveOriginal;
        if (typeof args.dir === "string") input.dir = args.dir;
        return vault.uploadImageAsset(input);
      }
    },
    {
      name: "vault_create_note_with_assets",
      title: "Vault Create Note With Assets",
      description: `Create a Markdown note and store small image assets in the existing adjacent assets directory, replacing {{asset:n}} placeholders with Obsidian embeds. Neither the note parent nor asset directory is created implicitly. ${integrityModeDescription}`,
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          content: { type: "string", description: "Markdown content. Use placeholders like {{asset:0}} to embed uploaded assets by index." },
          assets: {
            type: "array",
            description: "Image assets to upload beside the note. Asset indexes correspond to {{asset:n}} placeholders in content.",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "Original image filename. The extension must match the MIME type." },
                mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"], description: "Image MIME type for the decoded bytes." },
                contentBase64: { type: "string", description: "Base64-encoded image bytes." },
                expectedSha256: { type: "string", description: expectedSha256Description },
                expectedSize: { type: "integer", minimum: 1, description: expectedSizeDescription },
                preserveOriginal: { type: "boolean", description: "Set true when the upload must preserve original bytes; this requires expectedSha256 and expectedSize in the default integrity mode." }
              },
              required: imageAssetRequiredFields,
              additionalProperties: false
            }
          }
        },
        required: ["path", "content", "assets"],
        additionalProperties: false
      },
      handler: async (args) => vault.createNoteWithAssets(String(args.path), String(args.content ?? ""), parseImageAssets(args.assets))
    },
    {
      name: "vault_create_external_reference_note",
      title: "Vault Create External Reference Note",
      description: "Create a structured Markdown note inside an existing directory that references external source files without uploading those files into the vault. This tool never creates directories.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          title: { type: "string", description: "Display title for the generated reference note." },
          references: {
            type: "array",
            description: "External source references to record in the note without copying the source files.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Human-readable source label." },
                location: { type: "string", description: "Source location, such as a local path, URL, or identifier." },
                type: { type: "string", description: "Optional source type, such as pdf, image, web, or dataset." },
                note: { type: "string", description: "Optional note about this source." }
              },
              required: ["label", "location"],
              additionalProperties: false
            }
          },
          summary: { type: "string", description: "Optional short summary to include in the generated note." },
          keyFindings: { type: "array", description: "Optional bullet-style findings to include.", items: { type: "string" } },
          nextActions: { type: "array", description: "Optional follow-up actions to include.", items: { type: "string" } }
        },
        required: ["path", "title", "references"],
        additionalProperties: false
      },
      handler: async (args) => {
        const input: {
          path: string;
          title: string;
          references: Array<{ label: string; location: string; type?: string; note?: string }>;
          summary?: string;
          keyFindings?: string[];
          nextActions?: string[];
        } = {
          path: String(args.path),
          title: String(args.title ?? ""),
          references: parseExternalReferences(args.references)
        };
        if (typeof args.summary === "string") input.summary = args.summary;
        const keyFindings = parseOptionalStringArray(args.keyFindings, "keyFindings");
        if (keyFindings) input.keyFindings = keyFindings;
        const nextActions = parseOptionalStringArray(args.nextActions, "nextActions");
        if (nextActions) input.nextActions = nextActions;
        return vault.createExternalReferenceNote(input);
      }
    }
  ];
  return tools.filter((tool) => toolEnabled(tool.name));
}

function toolEnabled(name: string): boolean {
  if (!config.readOnly) {
    if (name === "vault_write") return config.enableVaultWrite;
    if (name === "vault_append") return config.enableVaultAppend;
    if (name === "vault_patch") return config.enableVaultPatch;
    if (name === "vault_delete") return config.enableVaultDelete;
    if (name === "vault_move") return config.enableVaultMove;
    if (name === "vault_create_directory") return config.enableVaultCreateDirectory;
    if (name === "append_to_inbox") return config.enableAppendToInbox;
    if (name === "vault_upload_image_asset") return config.enableImageAssets;
    if (name === "vault_create_note_with_assets") return config.enableImageAssets;
    if (name === "vault_create_external_reference_note") return config.enableExternalReferenceNotes;
    return true;
  }

  return ![
    "vault_write",
    "vault_append",
    "vault_patch",
    "vault_delete",
    "vault_move",
    "vault_create_directory",
    "append_to_inbox",
    "vault_upload_image_asset",
    "vault_create_note_with_assets",
    "vault_create_external_reference_note"
  ].includes(name);
}

function parseImageAssets(value: unknown): Array<{ filename: string; mimeType: string; contentBase64: string; expectedSha256?: string; expectedSize?: number; preserveOriginal?: boolean }> {
  if (!Array.isArray(value)) throw new Error("assets must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`assets[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    const parsed: { filename: string; mimeType: string; contentBase64: string; expectedSha256?: string; expectedSize?: number; preserveOriginal?: boolean } = {
      filename: String(record.filename ?? ""),
      mimeType: String(record.mimeType ?? ""),
      contentBase64: String(record.contentBase64 ?? "")
    };
    if (typeof record.expectedSha256 === "string") parsed.expectedSha256 = record.expectedSha256;
    if (typeof record.expectedSize === "number") parsed.expectedSize = record.expectedSize;
    if (typeof record.preserveOriginal === "boolean") parsed.preserveOriginal = record.preserveOriginal;
    return parsed;
  });
}

function parseExternalReferences(value: unknown): Array<{ label: string; location: string; type?: string; note?: string }> {
  if (!Array.isArray(value)) throw new Error("references must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`references[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    const reference: { label: string; location: string; type?: string; note?: string } = {
      label: String(record.label ?? ""),
      location: String(record.location ?? "")
    };
    if (typeof record.type === "string") reference.type = record.type;
    if (typeof record.note === "string") reference.note = record.note;
    return reference;
  });
}

function parseOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${name}[${index}] must be a string`);
    return item;
  });
}

function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${name}[${index}] must be a string`);
    return item;
  });
}
