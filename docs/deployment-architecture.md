# Deployment Architecture

[中文文档](deployment-architecture.zh-CN.md)

This document describes the recommended production-style deployment pattern.

## Recommended Topology

```text
Obsidian clients
  <-> LiveSync plugin
  <-> CouchDB
  <-> livesync-cli daemon
  <-> shared vault PVC
  <-> obsidian-vault-mcp Service
  <-> private tunnel client
  <-> ChatGPT Connector
```

The MCP server never needs to run Obsidian. It reads and writes a normal Markdown vault directory that is synchronized by `livesync-cli`.

## Kubernetes Components

### LiveSync daemon

The LiveSync CLI runs as a long-lived Deployment. It connects to CouchDB and mirrors the LiveSync database into a normal filesystem vault mounted from a PVC.

Recommended initial settings:

```text
CHOKIDAR_USEPOLLING=true
CHOKIDAR_INTERVAL=1000
livesync-cli ... daemon --interval 10
```

Polling is conservative and works well for small personal vaults. Later, operators can tune node inotify limits or implement a CouchDB `_changes` based flow for lower latency.

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
- validate LiveSync daemon against a shared vault PVC;
- validate MCP write/read/delete against the shared vault;
- validate ChatGPT Connector through the private tunnel;
- validate image asset and external reference note tools;
- verify audit logs, trash, and backups;
- rotate any runtime API key used during testing.
