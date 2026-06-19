# 部署架构

[English](deployment-architecture.md)

本文档描述推荐的生产化部署模式，不包含任何特定环境的私有值。

## 推荐拓扑

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

MCP Server 不需要运行 Obsidian。它只读写一个普通 Markdown vault 目录，这个目录由 `livesync-cli` 从 CouchDB 同步出来。

## Kubernetes 组件

### LiveSync daemon

LiveSync CLI 作为长运行 Deployment 部署。它连接 CouchDB，并把 LiveSync 数据库镜像成 PVC 上的普通文件系统 vault。

初始推荐配置：

```text
CHOKIDAR_USEPOLLING=true
CHOKIDAR_INTERVAL=1000
livesync-cli ... daemon --interval 10
```

Polling 是保守方案，对个人小型 vault 足够稳定。后续可以提高节点 inotify 限制，或实现基于 CouchDB `_changes` 的低延迟流程。

### Obsidian Vault MCP

MCP Server 作为独立 Deployment 运行，并挂载同一个 vault PVC。

公网或共享部署建议使用默认 token-protected profile：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/default
```

单人私有 tunnel 部署可以使用 personal full-access profile：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
```

全权限 profile 会启用所有 mutating tools 和恢复能力：

```text
TRASH_DELETE=true
BACKUP_BEFORE_WRITE=true
ENABLE_AUDIT_LOG=true
```

### Private tunnel client

tunnel client 可以作为独立 Deployment 或 sidecar 运行。它通过 outbound HTTPS 连接 tunnel provider，并把 MCP 请求转发到集群内 MCP Service：

```text
http://obsidian-vault-mcp.YOUR_NAMESPACE.svc.cluster.local/mcp
```

如果 Kubernetes 集群访问公网需要 outbound proxy，并且 tunnel client 支持按 route 配置 proxy，建议只给 tunnel control-plane 流量配置 proxy。到集群内 MCP Service 的流量应保持 direct。

## Secret

不要提交真实 secret。

常见 secret：

- CouchDB URL、数据库名、用户名、密码、LiveSync 加密 passphrase；
- default profile 使用的 MCP bearer token；
- tunnel runtime API key 和 tunnel identifier。

仓库示例只使用占位符。

## 数据安全

personal full-access profile 权限很高。建议保持：

- `TRASH_DELETE=true`；
- `BACKUP_BEFORE_WRITE=true`；
- 文件审计日志开启；
- LiveSync 历史或其他独立备份可用；
- 切换主 vault 前做一次恢复演练。

删除行为应验证为：

```text
原始笔记消失
.trash/ 下出现副本
.backups/ 下出现备份
audit log 记录 vault_delete success
```

## 验证清单

生产切换前：

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `docker build -t obsidian-vault-mcp:ci .`
- 用 `kubectl kustomize` 渲染 Kubernetes profiles；
- 使用隔离 CouchDB 数据库验证 LiveSync one-shot sync；
- 使用 shared vault PVC 验证 LiveSync daemon；
- 针对 shared vault 验证 MCP write/read/delete；
- 通过 private tunnel 验证 ChatGPT Connector；
- 验证 image asset 和 external reference note tools；
- 验证 audit logs、trash、backups；
- 轮换测试期间使用过的 runtime API key。
