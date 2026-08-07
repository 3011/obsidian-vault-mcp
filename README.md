# Obsidian Vault MCP

[中文文档](README.zh-CN.md)

Headless Obsidian Vault MCP server backed by a normal Markdown vault directory.

It is designed for:

```text
livesync-cli daemon -> /data/vault -> obsidian-vault-mcp -> ChatGPT Connector
```

It does not depend on Obsidian, plugin APIs, command palette, active files, or GUI state.

## Quick Start

Clone the repository, build the image locally, then start the server:

```bash
git clone https://github.com/3011/obsidian-vault-mcp.git
cd obsidian-vault-mcp
docker build -t obsidian-vault-mcp:local .

mkdir -p "$HOME/obsidian-vault/98-Inbox"
export MCP_TOKEN="$(openssl rand -hex 32)"
docker run --rm --user "$(id -u):$(id -g)" -p 8080:8080 \
  -e MCP_TOKEN="$MCP_TOKEN" \
  -v "$HOME/obsidian-vault:/data/vault" \
  obsidian-vault-mcp:local
```

Verify the server at `http://localhost:8080/healthz`, then configure your MCP client with endpoint `http://localhost:8080/mcp` and bearer token `$MCP_TOKEN`.

For Kubernetes and LiveSync deployments, see [`deploy/README.zh-CN.md`](deploy/README.zh-CN.md) and [`docs/deployment-architecture.md`](docs/deployment-architecture.md).

## Tools

- `vault_list`: list vault files and folders.
- `vault_list_detailed`: return structured path facts, file metadata, attachment markers, warnings, and scan IDs.
- `vault_read`: read full note metadata/content or a heading, block, or frontmatter target; read supported text files.
- `vault_write`: deprecated compatibility upsert tool.
- `vault_create_note`: atomically create a new Markdown note without overwriting.
- `vault_replace_note`: replace an existing note only when its raw-byte SHA-256 matches.
- `vault_append`: append content to a Markdown file, creating it if missing.
- `vault_patch`: patch heading, block, or frontmatter targets.
- `vault_delete`: delete a vault file or empty folder.
- `vault_move`: move or rename a vault file.
- `vault_get_operation`: query a WAL-backed move/delete operation.
- `vault_get_document_map`: list headings, block refs, frontmatter fields, links, embeds, and tags.
- `search_simple`: full-vault substring search with context.
- `search_query`: structured Markdown search by path glob, tag, frontmatter equality, and content substring.
- `find_asset_references`: read-only reference analysis for one or more asset paths with conservative `trashSafety`.
- `asset_audit`: read-only directory-level asset audit combining detailed listing and reference analysis.
- `tag_list`: list tags with counts, including nested tag parent counts.
- `append_to_inbox`: append content to a note under the default inbox directory.
- `vault_import_file`: transfer a host-provided file into any allowed vault-relative file path with size/SHA-256 verification and protected overwrite semantics.
- `vault_export_file`: return any allowed vault file as an embedded MCP binary resource for host-side materialization.
- `vault_create_external_reference_note`: create a structured note that references external files without uploading them.

Destructive tools are intentionally exposed because the operator accepts that risk. The server still blocks absolute paths, `..`, symlink escape, temp files, and sensitive vault internals such as `.obsidian/`, `.livesync/`, `.git/`, `.trash/`, and `node_modules/`.

## Implementation Notes

- Full-file `vault_read` returns content, metadata, and a `revision`. `revision.sha256` is calculated from the exact on-disk bytes without Markdown, newline, Unicode, or encoding normalization. Targeted reads keep returning the selected target value.
- `vault_list_detailed` distinguishes missing paths, files, empty directories, non-empty directories, denied paths, and skipped entries. It can recurse and optionally compute SHA-256 hashes.
- `find_asset_references` supports Obsidian wikilinks, Markdown image links, and common HTML `<img src>` references. It ignores fenced code blocks and inline code. It reports `scanCompleteness`, `candidateOrphan`, `trashSafety`, evidence, and warnings.
- `asset_audit` is read-only and does not move, delete, or rewrite files. It combines `vault_list_detailed` and `find_asset_references`; `candidateOrphan=true` means no supported structured reference was found, while `trashSafety=safe` is only returned for full-vault scans with no references, ambiguity, unresolved matches, unsupported matches, duplicates, or relevant warnings. Uncertain cases return `trashSafety=unknown`.
- `vault_write` keeps the legacy upsert behavior. New callers should use `vault_create_note` or `vault_replace_note`; create-only commits use a same-directory temporary file and a hard-link no-replace operation.
- `vault_append` creates missing Markdown files and preserves existing content; optional `expectedSha256` detects concurrent changes.
- `vault_patch` supports heading, block, and frontmatter targets with `replace`, `prepend`, and `append`; it also supports `createTargetIfMissing`, `rejectIfContentPreexists`, `trimTargetWhitespace`, `targetDelimiter`, `contentType`, and `targetScope`.
- Duplicate heading paths currently follow `markdown-patch` map behavior: the later matching heading wins. Prefer unique heading paths when using `vault_patch` or pass a more specific nested path.
- `vault_delete` deletes vault files and empty directories. WAL-backed file deletes return an `operationId`; empty-directory deletes and deployments without WAL finish synchronously without a temporary ID.
- `vault_move` supports destination directories ending in `/` and optional overwrite. Overwrite uses one atomic rename without deleting the destination first. WAL-backed moves return an `operationId` queryable through `vault_get_operation`.
- `vault_import_file` does not use a MIME allowlist. It streams the host-authorized source into a bounded spool, verifies optional `expectedSha256`/`expectedSize`, then atomically commits exact bytes into an existing vault directory.
- Importing over different existing content requires both `allowOverwrite=true` and `expectedDestinationSha256`. Identical content is an idempotent success. Existing content is backed up before replacement when `BACKUP_BEFORE_WRITE=true`.
- `vault_export_file` emits an embedded MCP resource and verifies SHA-256/size. Embedded exports are hard-capped at 4 MiB; oversized files fail instead of being truncated or exposed through a public URL.
- `vault_create_external_reference_note` is for NAS, cloud drive, ticket, PDF, Word, Excel, zip, or log bundle references that should not be stored in the vault.
- `search_simple` returns all matches per file with filename/content source and context.
- `search_query` searches Markdown files with path glob, tag, frontmatter equality, and content substring filters.
- `tag_list` scans frontmatter tags and inline tags, including parent counts for nested tags.

### Interface reliability contract

- Unknown tool names and inputSchema failures return JSON-RPC `-32602`; domain failures after execution starts return `isError=true` with a structured `error`.
- `expectedSha256` is checked against raw bytes while holding the same path lock used for the mutation, and the new revision is generated before releasing that lock. The current lock is process-local, so production keeps one MCP replica.
- WAL commit level is derived only from facts: `remoteVerifiedAt` means remote, `localCommittedAt` means local, cancelled with neither means none, and every other missing-timestamp state means unknown.
- `remote` means the Controller completed LiveSync synchronization and post-sync `livesync-cli info` checks; it does not claim direct CouchDB revision verification.
- `OPERATION_NOT_FOUND` may also mean the record exceeded retention or WAL storage is unavailable.

## File Transfer

`vault_import_file` uses the host file-parameter channel rather than Base64 inside ordinary MCP arguments. In ChatGPT, `tools/list` advertises `_meta["openai/fileParams"] = ["file"]`, so ChatGPT supplies an authorized temporary file reference. The server downloads it into a bounded spool, computes SHA-256 and byte size, and commits it without byte conversion.

Recommended integrity-sensitive import:

```json
{
  "file": "<host file>",
  "destination": "Projects/assets/original.pdf",
  "expectedSha256": "<64 hex characters>",
  "expectedSize": 91353
}
```

Replacing different existing content is deliberately stricter:

```json
{
  "file": "<host file>",
  "destination": "Projects/assets/original.pdf",
  "allowOverwrite": true,
  "expectedDestinationSha256": "<current destination SHA-256>"
}
```

`vault_export_file` returns an embedded MCP binary resource. The hard export ceiling is 4 MiB because the blob is Base64-encoded at the MCP protocol layer and host materialization has a practical size ceiling. There is no resource-link/public-URL fallback.

## Run

```bash
mkdir -p /tmp/vault/98-Inbox/assets
npm run build
MCP_TOKEN=change-me VAULT_ROOT=/tmp/vault npm start
```

The configured inbox must already exist. Note and file-import tools never create parent directories implicitly.

## Configuration

| Env | Default | Description |
| --- | --- | --- |
| `MCP_HOST` | `0.0.0.0` | Listen host. |
| `MCP_PORT` | `8080` | Listen port. |
| `MCP_PATH` | `/mcp` | Streamable HTTP MCP endpoint. |
| `MCP_TOKEN` | empty | Bearer token. |
| `MCP_TOKEN_FILE` | empty | File containing bearer token. |
| `MCP_REQUIRE_TOKEN` | `true` | Require bearer token. |
| `MCP_PUBLIC_BASE_URL` | empty | Public base URL used in metadata responses. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated CORS allowlist; `*` allows all. |
| `VAULT_ROOT` | `/data/vault` | Markdown vault root. |
| `MUTATION_QUEUE_DIR` | empty | Optional absolute WAL directory for LiveSync delete/move mutation intents. Must not be inside `VAULT_ROOT`. |
| `DEFAULT_WRITE_DIR` | `98-Inbox` | Existing inbox directory for `append_to_inbox`. Startup fails when the tool is enabled and this directory is missing. |
| `MAX_REQUEST_BYTES` | `16777216` | Maximum JSON request body size. File bytes are not carried in ordinary tool arguments. |
| `READ_ONLY` | `false` | Hide all mutating tools when true. |
| `ENABLE_VAULT_WRITE` | `true` | Expose `vault_write`. |
| `ENABLE_VAULT_APPEND` | `true` | Expose `vault_append`. |
| `ENABLE_VAULT_PATCH` | `true` | Expose `vault_patch`. |
| `ENABLE_VAULT_DELETE` | `true` | Expose `vault_delete`. |
| `ENABLE_VAULT_MOVE` | `true` | Expose `vault_move`. |
| `ENABLE_VAULT_CREATE_DIRECTORY` | `true` | Expose deliberate one-level directory creation. |
| `ENABLE_APPEND_TO_INBOX` | `true` | Expose `append_to_inbox`. |
| `ENABLE_FILE_TRANSFER` | `true` | Expose `vault_import_file` and `vault_export_file`. In `READ_ONLY=true`, import is hidden while export remains available. |
| `MAX_FILE_TRANSFER_BYTES` | `268435456` | Maximum imported source size (256 MiB by default). |
| `MAX_EMBEDDED_EXPORT_BYTES` | `4194304` | Embedded export ceiling. Hard-capped at 4 MiB even if configured higher. |
| `FILE_TRANSFER_SPOOL_DIR` | `/tmp/obsidian-vault-mcp-files` | Temporary spool directory for inbound files. |
| `FILE_TRANSFER_TIMEOUT_SECONDS` | `600` | End-to-end source download timeout. |
| `FILE_IMPORT_ALLOWED_HOSTS` | empty | Optional comma-separated exact hosts or suffix rules such as `.blob.core.windows.net`; empty permits any HTTPS host. |
| `FILE_IMPORT_ALLOW_HTTP` | `false` | Permit HTTP source URLs. Intended only for local tests. |
| `ENABLE_EXTERNAL_REFERENCE_NOTES` | `true` | Expose external reference note creation. |
| `ENABLE_AUDIT_LOG` | `true` | Log mutating operations as JSON. |
| `AUDIT_LOG_PATH` | empty | Optional JSONL audit log file path. Defaults to stdout when empty. |
| `TRASH_DELETE` | `true` | Move deleted vault files into the trash directory instead of permanent deletion. |
| `TRASH_DIR` | `.trash` | Vault recovery directory for deleted notes. |
| `BACKUP_BEFORE_WRITE` | `true` | Copy existing vault files before write, append, patch, move, and delete operations. |
| `BACKUP_DIR` | `.backups` | Vault recovery directory for backups. |

## Safety Model

The server allows destructive tools when enabled, but still enforces baseline file safety:

- no absolute paths;
- no `..` path traversal;
- no symlink escape from the vault root;
- no access to `.obsidian/`, `.livesync/`, `.git/`, `.trash/`, `.backups`, or `node_modules/`;
- no temp/swap files;
- no writes directly in the vault root;
- no implicit parent-directory creation by note, file-import, or move tools;
- explicit `vault_create_directory` creates one level only, requires a reason, and is intended only after inspecting existing directories; an empty parent creates a new top-level directory;
- startup validation for the configured inbox when inbox capture is enabled;
- generic attachment import is allowed only through `vault_import_file`, with vault path checks, bounded transfer size, optional source integrity checks, and protected overwrite semantics;
- embedded file export is hard-capped at 4 MiB and never falls back to a public download URL;
- per-file locks for write, append, patch, import, export, move, and delete;
- atomic writes with temp file, fsync, and rename;
- default trash deletes and backup-before-write recovery copies;
- JSON audit logs for mutating operations.

## Test

```bash
npm run typecheck
npm test
```

The test suite starts the HTTP MCP server and covers all exposed tools, authentication failure, path traversal rejection, sensitive directory rejection, symlink escape rejection, missing-parent rejection without directory creation, root-write rejection, write-root allowlists, overwrite move behavior, patch variants, image asset validation, external reference note creation, search multi-match behavior, and tag aggregation.

It also runs an official `@modelcontextprotocol/sdk` Streamable HTTP client compatibility test that verifies published `outputSchema`, structured success output, and calls including `vault_read`, `vault_write`, and `search_simple`.

Additional split tests cover per-file concurrent append locking and Markdown/YAML boundary cases including complex frontmatter, Unicode headings, fenced code blocks, duplicate heading behavior, CRLF input, and table patching via `markdown-patch`.

## Protocol Compatibility

Tested with:

- `@modelcontextprotocol/sdk` `^1.29.0`
- Streamable HTTP client transport
- Bearer token authentication
- OpenAI Secure MCP Tunnel with ChatGPT Connector in a personal full-access k3s deployment

Supported JSON-RPC methods:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

## Build

```bash
docker build -t ghcr.io/3011/obsidian-vault-mcp:main .
docker push ghcr.io/3011/obsidian-vault-mcp:main
```

GitHub Actions publishes `main` and immutable `sha-*` images for pushes to `main`. Tags matching `v*` publish the git tag, semantic-version aliases, `latest`, and a GitHub Release.

> GitHub Container Registry packages under personal accounts are private on first publish. To allow anonymous pulls from `ghcr.io/3011/obsidian-vault-mcp`, change the package visibility to **Public** in GitHub Package settings.

## Kubernetes Example

Split manifests and Chinese deployment notes are available under `deploy/`; see `deploy/README.zh-CN.md`.
For the recommended LiveSync + MCP + private tunnel topology, see `docs/deployment-architecture.md`.

```bash
kubectl -n YOUR_NAMESPACE create secret generic obsidian-vault-mcp-token \
  --from-literal=MCP_TOKEN="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n YOUR_NAMESPACE apply -k deploy/default
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

## Personal Full-Access Tunnel

For pure personal use where ChatGPT is intentionally allowed to use every vault tool, use the full-access tunnel profile:

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

This profile sets `MCP_REQUIRE_TOKEN=false`, `READ_ONLY=false`, and enables write, append, patch, delete, move, inbox append, generic file transfer, and external reference note tools. It assumes the MCP server is only reachable through a private tunnel such as OpenAI Secure MCP Tunnel, with the tunnel upstream pointed at:

```text
http://obsidian-vault-mcp:80/mcp
```

See `docs/personal-full-access.md` before using this profile with a primary vault.

The generic file-transfer path is covered by automated import/export integrity, overwrite-safety, size-limit, symlink/path-boundary, embedded-resource, and SDK compatibility tests. Re-run the ChatGPT tunnel matrix after deploying a new image.

## Project History

Historical implementation plans are retained under [`docs/history/`](docs/history/) for design context. Current release changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and vulnerabilities should follow [SECURITY.md](SECURITY.md).
