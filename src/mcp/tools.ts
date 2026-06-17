import { config } from "../config.js";
import { FsVault } from "../vault/FsVault.js";
import type { Tool } from "./types.js";

const mdPath = { type: "string", description: "Vault-relative Markdown .md path." };

export function buildTools(vault: FsVault): Tool[] {
  const tools: Tool[] = [
    {
      name: "vault_list",
      title: "Vault List",
      description: "List files and subdirectories inside a vault directory. Directory entries end with '/'.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path relative to the vault root." } },
        additionalProperties: false
      },
      handler: async (args) => ({ files: await vault.list(String(args.path ?? "")) })
    },
    {
      name: "vault_read",
      title: "Vault Read",
      description: "Read a Markdown note and metadata. With targetType and target, read only a heading, block, or frontmatter field.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          targetType: { type: "string", enum: ["heading", "block", "frontmatter"] },
          target: { type: "string" },
          targetDelimiter: { type: "string", default: "::" }
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
      description: "Create or overwrite a Markdown file. This is intentionally exposed because the operator accepts the risk.",
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
      description: "Append Markdown content to a note, creating the file if missing.",
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
      name: "vault_patch",
      title: "Vault Patch",
      description: "Patch a heading, block reference, or frontmatter field with replace, prepend, or append.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          targetType: { type: "string", enum: ["heading", "block", "frontmatter"] },
          target: { type: "string" },
          operation: { type: "string", enum: ["replace", "prepend", "append"] },
          content: {},
          contentType: { type: "string", enum: ["text/markdown", "application/json"] },
          createTargetIfMissing: { type: "boolean" },
          trimTargetWhitespace: { type: "boolean" },
          rejectIfContentPreexists: { type: "boolean" },
          targetDelimiter: { type: "string", default: "::" },
          targetScope: { type: "string", enum: ["content", "marker", "markerAndContent"], default: "content" }
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
      description: "Delete a Markdown file from the vault.",
      inputSchema: {
        type: "object",
        properties: { path: mdPath },
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
      description: "Move or rename a Markdown file. If destination ends with '/', the original filename is preserved.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          destination: { type: "string", description: "Destination .md path or directory ending with /." },
          allowOverwrite: { type: "boolean", default: false }
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
      description: "Return headings, block references, frontmatter fields, links, embeds, and tags for a note.",
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
      description: "Search Markdown notes with a case-insensitive substring search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          contextLength: { type: "number", default: 100 },
          limit: { type: "number", default: 100 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args) => vault.searchSimple(String(args.query), Number(args.contextLength ?? 100), Number(args.limit ?? 100))
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
      description: "Append Markdown content to a note under the default inbox directory.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Inbox note title or filename." },
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
      description: "Upload a small image asset into the vault and return an Obsidian embed link. Only image assets are accepted.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
          contentBase64: { type: "string" },
          dir: { type: "string", description: "Optional vault-relative asset directory. Defaults to the inbox assets directory." }
        },
        required: ["filename", "mimeType", "contentBase64"],
        additionalProperties: false
      },
      handler: async (args) => {
        const input: { filename: string; mimeType: string; contentBase64: string; dir?: string } = {
          filename: String(args.filename ?? ""),
          mimeType: String(args.mimeType ?? ""),
          contentBase64: String(args.contentBase64 ?? "")
        };
        if (typeof args.dir === "string") input.dir = args.dir;
        return vault.uploadImageAsset(input);
      }
    },
    {
      name: "vault_create_note_with_assets",
      title: "Vault Create Note With Assets",
      description: "Create a Markdown note and store small image assets beside it, replacing {{asset:n}} placeholders with Obsidian embeds.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          content: { type: "string" },
          assets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string" },
                mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
                contentBase64: { type: "string" }
              },
              required: ["filename", "mimeType", "contentBase64"],
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
      description: "Create a structured Markdown note that references external source files without uploading them into the vault.",
      inputSchema: {
        type: "object",
        properties: {
          path: mdPath,
          title: { type: "string" },
          references: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                location: { type: "string" },
                type: { type: "string" },
                note: { type: "string" }
              },
              required: ["label", "location"],
              additionalProperties: false
            }
          },
          summary: { type: "string" },
          keyFindings: { type: "array", items: { type: "string" } },
          nextActions: { type: "array", items: { type: "string" } }
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
    "append_to_inbox",
    "vault_upload_image_asset",
    "vault_create_note_with_assets",
    "vault_create_external_reference_note"
  ].includes(name);
}

function parseImageAssets(value: unknown): Array<{ filename: string; mimeType: string; contentBase64: string }> {
  if (!Array.isArray(value)) throw new Error("assets must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`assets[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    return {
      filename: String(record.filename ?? ""),
      mimeType: String(record.mimeType ?? ""),
      contentBase64: String(record.contentBase64 ?? "")
    };
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
