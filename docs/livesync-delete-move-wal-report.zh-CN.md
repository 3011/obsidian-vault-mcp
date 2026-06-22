# LiveSync Delete/Move 文件复活问题报告

[English](livesync-delete-move-wal-report.md)

## 摘要

在 headless Obsidian + LiveSync CLI + MCP 的部署中，曾出现 `vault_move` 返回成功后，源路径和目标路径同时存在的问题。排查确认：MCP 文件系统移动本身成功，源文件是后续被 LiveSync 恢复出来的。

根因不是普通的同步顺序问题，而是 delete/move 没有进入 LiveSync/CouchDB 的可复制 mutation 语义。仅删除或移动本地文件时，LiveSync local DB / CouchDB 中旧路径仍可能是 active 文档；后续 `mirror` 或 daemon initial mirror scan 会把 DB-only active 文档恢复到 vault。

最终修复方向：

```text
MCP 写 /vault
MCP 写 /mutations WAL
LiveSync controller 串行消费 WAL
CouchDB 收到 deleted revision
mirror 退出日常同步主链路
```

## 现象

典型现象：

```text
1. MCP vault_move oldPath -> newPath 返回成功
2. 文件系统短时间内 oldPath 消失、newPath 存在
3. LiveSync 后续同步后 oldPath 重新出现
4. 最终表现为 oldPath 和 newPath 同时存在
```

这说明 `rename(2)` / Node `fs.rename` 不是失败点。真正的问题是旧路径没有被写入 LiveSync DB 的删除语义。

## 根因

LiveSync CLI 的 `mirror` 语义会处理 DB 与 storage 的差异。对于 database-only active 文件，`mirror` 会把文件从 DB 恢复到 storage。也就是说：

```text
local file missing
LiveSync DB still active
=> restore local file
```

这和用户意图中的“删除旧路径”相反。

CouchDB/LiveSync 这类复制模型里，删除不是“本地文件不存在”这么简单，而是需要一个可复制的 deleted revision。否则其他副本只能看到旧文档仍然存在。

因此，依赖下面的链路是不可靠的：

```text
MCP rm/mv local file
期待 mirror 推断 delete
```

正确链路应为：

```text
MCP 产生 delete/move 意图
LiveSync controller 执行 livesync-cli rm / push / sync
CouchDB 复制 deleted revision
```

## 排查结论

已经确认的事实：

- MCP 与 LiveSync 是解耦的，MCP 不直接调用 `livesync-cli`，也不直接写 CouchDB。
- MCP 的 `vault_move` 使用文件系统 rename；rename 成功时源路径会立即消失。
- 源路径复活发生在 LiveSync 同步之后。
- 将同步循环调整为 `mirror -> sync -> mirror` 只能缓解部分新文件场景，不能根治历史残留和停机窗口问题。
- 单纯依赖 daemon/inotify 也不完整，因为 daemon 启动时仍有 initial mirror scan；停机期间发生的 MCP delete/move 仍可能被恢复。

## 修复设计

### 目录分离

目标部署使用三个目录：

```text
/vault       Obsidian vault 文件
/data        LiveSync local DB / settings
/mutations   MCP 与 controller 共享的 WAL
```

`/mutations` 不能放在 vault 内，避免被 Obsidian/LiveSync 当普通文件同步。

### MCP WAL

MCP 新增配置：

```text
MUTATION_QUEUE_DIR=/mutations
```

启用后，`vault_delete` 和 `vault_move` 会在真正删除/移动用户路径前写入 WAL：

```text
pending mutation
-> 文件系统 delete/move
-> ready mutation
```

如果 pending 写入失败，MCP 拒绝执行文件变更，避免出现“文件已删但没有 mutation 证据”的状态。

### LiveSync Controller

LiveSync 主链路改为 controller：

```text
livesync-controller
  -> 启动 livesync-cli daemon
  -> 发现 ready mutation
  -> 停止 daemon
  -> 串行执行 rm / push / sync
  -> mutation 进入 done
  -> 重启 daemon
```

controller 是唯一写 LiveSync local DB 的执行路径。避免长期存在：

```text
livesync-cli daemon
+
另一个 sidecar livesync-cli rm/push/sync
```

这可以规避多个进程并发读写 `/data/.livesync` 或 `/data/daemon` 的状态竞争。

### Delete 语义

```text
delete(path)
=> livesync-cli rm path
=> livesync-cli sync
=> path 不再 active
```

### Move 语义

```text
move(oldPath, newPath)
=> livesync-cli rm oldPath
=> livesync-cli push /vault/newPath newPath
=> livesync-cli sync
=> oldPath deleted, newPath active
```

如果 MCP 很快执行 `move -> delete`，controller 处理 move 时 `newPath` 可能已经不在 vault 中。此时 controller 按最终状态处理：

```text
oldPath deleted
newPath deleted
```

这避免快速连续操作把 mutation 卡进 failed。

## 已实施内容

代码侧：

- 新增 `MutationJournal`，负责 pending/ready WAL 原子写入。
- `FsVault.delete` 和 `FsVault.move` 接入 WAL。
- 新增 `livesync-controller/controller.mjs` wrapper。
- 新增 `livesync-controller/Dockerfile`，基于 LiveSync CLI 镜像构建 controller 镜像。
- 新增 mutation 与 controller 测试。

部署侧：

- 新增 `obsidian-mutations` PVC。
- MCP Deployment 挂载 `/mutations` 并设置 `MUTATION_QUEUE_DIR=/mutations`。
- LiveSync Deployment 从旧 mirror loop 切换为 controller 镜像。
- 旧的 `mirror -> sync -> mirror` 不再作为日常主链路。

## 验证结果

本地验证：

```text
npm run lint
npm run typecheck
npm test
kubectl kustomize deploy/default
kubectl kustomize deploy/personal-full-access
```

验证环境检查：

- `obsidian-vault-mcp` rollout 成功。
- `obsidian-livesync` rollout 成功。
- MCP 临时烟测完成：
  - `vault_write`
  - `vault_move`
  - `vault_delete`
- mutation 已从 `ready` 进入 `done`。
- `/mutations/failed`、`/mutations/ready`、`/mutations/processing` 均为空。
- 烟测文件源路径和目标路径均不存在。

## 运维注意事项

- 不要恢复旧的 `mirror -> sync -> mirror` 日常循环。
- 不要新增独立 sidecar 在 daemon 活跃时调用 `livesync-cli rm/push/sync`。
- `mirror` 只用于人工初始化或维护窗口。
- 如果 `/mutations/failed` 出现文件，先查看 JSON 中的 `error`，不要直接删除。
- 如果出现 `processing` 长时间不动，controller 会按超时规则恢复或失败；人工处理前应先确认 controller Pod 日志。
- 如果需要回滚，应同时考虑 MCP 与 LiveSync controller；只回滚其中一边可能重新引入“本地文件变化没有 DB mutation”的问题。

## 结论

本问题的根治点是把 delete/move 从普通文件系统事件升级为可审计、可重放、可复制的 mutation：

```text
MCP 产生意图
WAL 保存证据
LiveSync controller 串行写 DB
CouchDB 复制 deleted revision
```

这样可以避免 LiveSync 把旧路径误判为需要恢复的 DB-only active 文件，从根源上解决 move/delete 后旧文件复活的问题。
