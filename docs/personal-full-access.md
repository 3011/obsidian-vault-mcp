# Personal Full-Access Tunnel Profile

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

ENABLE_AUDIT_LOG=true
AUDIT_LOG_PATH=/data/audit/obsidian-vault-mcp.audit.log
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
```

## Kubernetes

Apply the full-access server profile:

```bash
kubectl apply -f deploy/openai-tunnel-full-access.yaml
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

Configure the tunnel client from the OpenAI tunnel setup flow so its upstream MCP URL points to:

```text
http://obsidian-vault-mcp:80/mcp
```

The Service is intentionally `ClusterIP`; it should only be reachable from inside the cluster.

## Operational Notes

This mode is intentionally powerful. The server still blocks path traversal, symlink escape, sensitive vault internals, and non-Markdown file targets, but GPT can create, overwrite, patch, move, and delete allowed Markdown files.

Before using it with a primary vault:

- keep Obsidian LiveSync or another backup/sync history enabled;
- keep audit logging enabled;
- test against a vault copy first;
- prefer `append_to_inbox` for routine capture workflows;
- review destructive tool calls carefully in the ChatGPT UI when confirmation is shown.

The next hardening features for this profile are trash mode for delete and backup-before-write for mutating tools.
