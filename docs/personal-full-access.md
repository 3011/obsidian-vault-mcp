# Personal Full-Access Tunnel Profile

[中文文档](personal-full-access.zh-CN.md)

This profile is for a single operator who intentionally gives ChatGPT full access to a private Obsidian vault through OpenAI Secure MCP Tunnel or another private tunnel.

It disables MCP server authentication because the tunnel is the network trust boundary:

```text
ChatGPT -> OpenAI tunnel endpoint -> tunnel client -> Kubernetes Service -> obsidian-vault-mcp
```

Use this only when the MCP endpoint is not exposed as a public unauthenticated HTTP service.

## Server Settings

```bash
MCP_REQUIRE_TOKEN=false
READ_ONLY=false

ENABLE_VAULT_WRITE=true
ENABLE_VAULT_APPEND=true
ENABLE_VAULT_PATCH=true
ENABLE_VAULT_DELETE=true
ENABLE_VAULT_MOVE=true
ENABLE_APPEND_TO_INBOX=true
ENABLE_FILE_TRANSFER=true
MAX_FILE_TRANSFER_BYTES=268435456
MAX_EMBEDDED_EXPORT_BYTES=4194304
FILE_TRANSFER_TIMEOUT_SECONDS=600
FILE_IMPORT_ALLOWED_HOSTS=.blob.core.windows.net,.oaiusercontent.com
ENABLE_EXTERNAL_REFERENCE_NOTES=true

ENABLE_AUDIT_LOG=true
AUDIT_LOG_PATH=/data/audit/obsidian-vault-mcp.audit.log

TRASH_DELETE=true
TRASH_DIR=.trash
BACKUP_BEFORE_WRITE=true
BACKUP_DIR=.backups
```

With these settings, every tool is exposed:

```text
vault_list
vault_read
vault_write
vault_append
vault_patch
vault_delete
vault_move
vault_get_document_map
search_simple
tag_list
append_to_inbox
vault_import_file
vault_export_file
vault_create_external_reference_note
```

## Kubernetes

Apply the full-access server profile:

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

Configure the tunnel client from the OpenAI tunnel setup flow so its upstream MCP URL points to:

```text
http://obsidian-vault-mcp:80/mcp
```

The Service is intentionally `ClusterIP`; it should only be reachable from inside the cluster.

## Operational Notes

This mode is intentionally powerful. The server still blocks path traversal, symlink escape, sensitive vault internals, implicit parent creation, and unprotected replacement of changed files. GPT can mutate allowed Markdown files and can import/export arbitrary allowed file types through the dedicated bounded file-transfer tools.

Deletes move notes into `.trash/` by default, and existing notes are copied into `.backups/` before write, append, patch, move, and delete operations. Both recovery directories are blocked from MCP note access.

Before using it with a primary vault:

- keep Obsidian LiveSync or another backup/sync history enabled;
- keep audit logging enabled;
- test against a vault copy first;
- prefer `append_to_inbox` for routine capture workflows;
- use `vault_import_file` when the actual file should live in the vault; use `expectedSha256` and `expectedSize` when exact source-byte integrity matters;
- replacing different existing content requires `allowOverwrite=true` plus the current `expectedDestinationSha256`;
- prefer `vault_create_external_reference_note` for large or externally managed PDFs, Office files, archives, and log bundles that should not be copied into the vault;
- remember that `vault_export_file` is intentionally hard-capped at 4 MiB per embedded export;
- review destructive tool calls carefully in the ChatGPT UI when confirmation is shown.

Automated coverage includes generic import/export integrity, overwrite protection, size ceilings, symlink/path boundaries, embedded-resource delivery, and SDK compatibility. Re-run the ChatGPT tunnel matrix after deploying a new image. Before cutting over a primary vault, still run a restore drill from `.trash/` and `.backups/` and rotate any runtime API key that was exposed during testing.
