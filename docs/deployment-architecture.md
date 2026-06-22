# Deployment Architecture

[中文文档](deployment-architecture.zh-CN.md)

This document describes the recommended production-style deployment pattern.

For the full investigation and fix record for LiveSync delete/move file resurrection, see [LiveSync Delete/Move Resurrection Report](livesync-delete-move-wal-report.md).

## Recommended Topology

```text
Obsidian clients
  <-> LiveSync plugin
  <-> CouchDB
  <-> livesync-controller
  <-> shared vault PVC
  <-> obsidian-vault-mcp Service
  <-> private tunnel client
  <-> ChatGPT Connector
```

The MCP server never needs to run Obsidian. It reads and writes a normal Markdown vault directory plus a separate mutation WAL directory. The LiveSync controller serializes `livesync-cli daemon` and explicit delete/move mutations so LiveSync/CouchDB receives deleted revisions instead of relying on mirror scans.

## Kubernetes Components

### LiveSync controller

The LiveSync controller runs as a long-lived Deployment. It mounts:

```text
/vault       # Markdown vault PVC
/data        # LiveSync local DB and settings PVC
/mutations   # MCP/controller mutation WAL PVC
```

It starts `livesync-cli daemon` for normal file watching. When a ready delete/move mutation appears, the controller stops the daemon, runs `livesync-cli rm` and `push`/`sync` serially, then starts the daemon again. Do not run an independent sidecar that calls `livesync-cli rm/push/sync` while the daemon is still active.

Recommended initial settings:

```text
CHOKIDAR_USEPOLLING=true
CHOKIDAR_INTERVAL=1000
livesync-cli ... daemon --interval 10
```

Polling is conservative and works well for small personal vaults. `mirror` should be kept for explicit maintenance windows only, not as the daily sync loop.

### Obsidian Vault MCP

The MCP server runs as a separate Deployment and mounts the same vault PVC.

For internet-facing or shared deployments, use the default token-protected profile:

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/default
```

For a single-operator private tunnel deployment, use the personal full-access profile:

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
```

The full-access profile enables all mutating tools and recovery features:

```text
MUTATION_QUEUE_DIR=/mutations
TRASH_DELETE=true
BACKUP_BEFORE_WRITE=true
ENABLE_AUDIT_LOG=true
```

### Private tunnel client

Run the tunnel client as a separate Deployment or sidecar. It should make outbound HTTPS requests to the tunnel provider and forward MCP requests to the in-cluster MCP Service:

```text
http://obsidian-vault-mcp.YOUR_NAMESPACE.svc.cluster.local/mcp
```

If the Kubernetes cluster requires an outbound proxy for internet access, configure that proxy only for the tunnel control-plane traffic when the tunnel client supports per-route proxy settings. Keep traffic to the in-cluster MCP Service direct.

## Secret Inputs

- CouchDB URL, database name, username, password, and LiveSync encryption passphrase.
- MCP bearer token for the default profile.
- Tunnel runtime API key and tunnel identifier.

## Data Safety

The personal full-access profile is intentionally powerful. Recommended safeguards:

- keep `TRASH_DELETE=true`;
- keep `BACKUP_BEFORE_WRITE=true`;
- keep file audit logging enabled;
- keep LiveSync history or another independent backup available;
- run a restore drill before cutting over a primary vault.

Delete behavior should be verified as:

```text
original note removed
copy appears under .trash/
backup appears under .backups/
audit log records vault_delete success
```

## Validation Checklist

Before production cutover:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `docker build -t obsidian-vault-mcp:ci .`
- render Kubernetes profiles with `kubectl kustomize`;
- validate LiveSync one-shot sync against an isolated CouchDB database;
- validate LiveSync controller against a shared vault PVC and mutation PVC;
- validate MCP write/read/delete against the shared vault;
- validate ChatGPT Connector through the private tunnel;
- validate image asset and external reference note tools;
- verify audit logs, trash, and backups;
- rotate any runtime API key used during testing.
