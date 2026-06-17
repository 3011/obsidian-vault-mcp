# Obsidian Vault MCP

Headless Obsidian Vault MCP server backed by a normal Markdown vault directory.

It is designed for:

```text
livesync-cli daemon -> /data/vault -> obsidian-vault-mcp -> ChatGPT Connector
```

It does not depend on Obsidian, plugin APIs, command palette, active files, or GUI state.

## Tools

- `vault_list`: list Markdown files and folders.
- `vault_read`: read full note metadata/content or a heading, block, or frontmatter target.
- `vault_write`: create or overwrite a Markdown file.
- `vault_append`: append content to a Markdown file, creating it if missing.
- `vault_patch`: patch heading, block, or frontmatter targets.
- `vault_delete`: delete a Markdown file.
- `vault_move`: move or rename a Markdown file.
- `vault_get_document_map`: list headings, block refs, frontmatter fields, links, embeds, and tags.
- `search_simple`: full-vault substring search with context.
- `tag_list`: list tags with counts, including nested tag parent counts.
- `append_to_inbox`: append content to a note under the default inbox directory.

Destructive tools are intentionally exposed because the operator accepts that risk. The server still blocks absolute paths, `..`, symlink escape, temp files, and sensitive vault internals such as `.obsidian/`, `.livesync/`, `.git/`, `.trash/`, and `node_modules/`.

## Implementation Notes

- `vault_read` returns content, parsed frontmatter, tags, file stat, links, and embeds. It can also read a heading, nested heading path, block reference, or frontmatter field.
- `vault_write` atomically creates or overwrites Markdown files.
- `vault_append` creates missing Markdown files and preserves existing content.
- `vault_patch` supports heading, block, and frontmatter targets with `replace`, `prepend`, and `append`; it also supports `createTargetIfMissing`, `rejectIfContentPreexists`, `trimTargetWhitespace`, `targetDelimiter`, `contentType`, and `targetScope`.
- Duplicate heading paths currently follow `markdown-patch` map behavior: the later matching heading wins. Prefer unique heading paths when using `vault_patch` or pass a more specific nested path.
- `vault_move` supports destination directories ending in `/` and optional overwrite.
- `search_simple` returns all matches per file with filename/content source and context.
- `tag_list` scans frontmatter tags and inline tags, including parent counts for nested tags.

## Run

```bash
npm run build
MCP_TOKEN=change-me VAULT_ROOT=/tmp/vault npm start
```

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
| `DEFAULT_WRITE_DIR` | `98-Inbox` | Inbox directory for `append_to_inbox`. |
| `MAX_REQUEST_BYTES` | `1048576` | Maximum JSON request body size. |
| `READ_ONLY` | `false` | Hide all mutating tools when true. |
| `ENABLE_VAULT_WRITE` | `true` | Expose `vault_write`. |
| `ENABLE_VAULT_APPEND` | `true` | Expose `vault_append`. |
| `ENABLE_VAULT_PATCH` | `true` | Expose `vault_patch`. |
| `ENABLE_VAULT_DELETE` | `true` | Expose `vault_delete`. |
| `ENABLE_VAULT_MOVE` | `true` | Expose `vault_move`. |
| `ENABLE_APPEND_TO_INBOX` | `true` | Expose `append_to_inbox`. |
| `ENABLE_AUDIT_LOG` | `true` | Log mutating operations as JSON. |

## Safety Model

The server allows destructive tools when enabled, but still enforces baseline file safety:

- no absolute paths;
- no `..` path traversal;
- no symlink escape from the vault root;
- no access to `.obsidian/`, `.livesync/`, `.git/`, `.trash/`, or `node_modules/`;
- no temp/swap files;
- per-file locks for write, append, patch, move, and delete;
- atomic writes with temp file, fsync, and rename;
- JSON audit logs for mutating operations.

## Test

```bash
npm run typecheck
npm test
```

The test suite starts the HTTP MCP server and covers all exposed tools, authentication failure, path traversal rejection, sensitive directory rejection, symlink escape rejection, overwrite move behavior, patch variants, search multi-match behavior, and tag aggregation.

It also runs an official `@modelcontextprotocol/sdk` Streamable HTTP client compatibility test that connects to `/mcp`, lists tools, and calls `vault_read`, `vault_write`, and `search_simple`.

Additional split tests cover per-file concurrent append locking and Markdown/YAML boundary cases including complex frontmatter, Unicode headings, fenced code blocks, duplicate heading behavior, CRLF input, and table patching via `markdown-patch`.

## Protocol Compatibility

Tested with:

- `@modelcontextprotocol/sdk` `^1.29.0`
- Streamable HTTP client transport
- Bearer token authentication

Supported JSON-RPC methods:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

## Build

```bash
docker build -t ghcr.io/YOUR_ORG/obsidian-vault-mcp:dev .
docker push ghcr.io/YOUR_ORG/obsidian-vault-mcp:dev
```

## Kubernetes Example

```bash
kubectl -n YOUR_NAMESPACE create secret generic obsidian-vault-mcp-token \
  --from-literal=MCP_TOKEN="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f deploy/kubernetes.yaml
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```
