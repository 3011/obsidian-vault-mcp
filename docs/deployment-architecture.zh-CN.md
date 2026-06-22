# 部署架构

[English](deployment-architecture.md)

本文档描述推荐的生产化部署模式。

LiveSync delete/move 文件复活问题的完整排查和修复记录见：[LiveSync Delete/Move 文件复活问题报告](livesync-delete-move-wal-report.zh-CN.md)。

## 推荐拓扑

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

MCP Server 不需要运行 Obsidian。它只读写普通 Markdown vault 目录和单独的 mutation WAL 目录。LiveSync controller 串行管理 `livesync-cli daemon` 和显式 delete/move mutation，让 LiveSync/CouchDB 收到 deleted revision，而不是依赖 mirror scan 猜测删除。

## Kubernetes 组件

### LiveSync controller

LiveSync controller 作为长运行 Deployment 部署，并挂载：

```text
/vault       # Markdown vault PVC
/data        # LiveSync local DB 和 settings PVC
/mutations   # MCP/controller mutation WAL PVC
```

它使用 `livesync-cli daemon` 处理正常文件监听。发现 ready delete/move mutation 时，controller 会停止 daemon，串行执行 `livesync-cli rm` 和 `push`/`sync`，再重新启动 daemon。不要再运行一个独立 sidecar 在 daemon 活跃时调用 `livesync-cli rm/push/sync`。

初始推荐配置：

```text
CHOKIDAR_USEPOLLING=true
CHOKIDAR_INTERVAL=1000
livesync-cli ... daemon --interval 10
```

Polling 是保守方案，对个人小型 vault 足够稳定。`mirror` 只应保留给明确的人工维护窗口，不再作为日常同步主循环。

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
MUTATION_QUEUE_DIR=/mutations
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

## Secret 输入

- CouchDB URL、数据库名、用户名、密码、LiveSync 加密 passphrase；
- default profile 使用的 MCP bearer token；
- tunnel runtime API key 和 tunnel identifier。

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
- 使用 shared vault PVC 和 mutation PVC 验证 LiveSync controller；
- 针对 shared vault 验证 MCP write/read/delete；
- 通过 private tunnel 验证 ChatGPT Connector；
- 验证 image asset 和 external reference note tools；
- 验证 audit logs、trash、backups；
- 轮换测试期间使用过的 runtime API key。
