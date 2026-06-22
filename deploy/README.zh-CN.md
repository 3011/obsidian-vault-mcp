# Kubernetes 部署说明

这个目录提供两套 Kubernetes 部署 profile，并且已经按资源类型拆分成多个文件，方便审查、覆盖和迁移到 Kustomize/Helm。

LiveSync delete/move 文件复活问题的完整排查和修复记录见：[`docs/livesync-delete-move-wal-report.zh-CN.md`](../docs/livesync-delete-move-wal-report.zh-CN.md)。

## 目录结构

```text
deploy/
  default/
    pvc.yaml
    deployment.yaml
    livesync-controller.yaml
    service.yaml
    kustomization.yaml
  personal-full-access/
    pvc.yaml
    deployment.yaml
    livesync-controller.yaml
    service.yaml
    kustomization.yaml
```

## Profile 选择

### `default`

通用部署 profile，适合公开 HTTPS 入口、Cloudflare Access、反向代理、或其他需要服务端 Bearer token 的场景。

特点：

- `MCP_REQUIRE_TOKEN=true`
- 从 Secret `obsidian-vault-mcp-token` 读取 `MCP_TOKEN`
- 使用 `ClusterIP` Service
- 默认镜像：`ghcr.io/3011/obsidian-vault-mcp:main`
- LiveSync controller 默认镜像：`ghcr.io/3011/obsidian-livesync-controller:main`

先创建 token Secret：

```bash
kubectl -n YOUR_NAMESPACE create secret generic obsidian-vault-mcp-token \
  --from-literal=MCP_TOKEN="$(openssl rand -hex 32)"
```

部署：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/default
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-livesync-controller
```

### `personal-full-access`

个人自用全权限 profile，适合 OpenAI Secure MCP Tunnel 这类私有 tunnel 场景。

特点：

- `MCP_REQUIRE_TOKEN=false`
- `READ_ONLY=false`
- 开启写入、追加、patch、删除、移动、inbox、图片资产、外部引用笔记工具
- 图片资产使用 `IMAGE_ASSET_INTEGRITY_MODE=required_for_preserve_original`
- `TRASH_DELETE=true`
- `BACKUP_BEFORE_WRITE=true`
- 审计日志写到 `/data/audit/obsidian-vault-mcp.audit.log`

部署：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-livesync-controller
```

OpenAI tunnel-client 的 upstream MCP URL 指向：

```text
http://obsidian-vault-mcp:80/mcp
```

这个 profile 不应该直接暴露到公网。它假设网络入口已经由私有 tunnel 控制。

## 替换命名空间

示例 YAML 不写死 namespace。部署时通过 `kubectl -n YOUR_NAMESPACE` 指定目标 namespace，或者在自己的 Kustomize overlay 里增加 `namespace` 字段。

## 数据目录

默认 PVC：

```text
obsidian-vault-mcp      -> /data/vault in MCP, /vault in controller
obsidian-livesync-db    -> /data in controller
obsidian-mutations      -> /mutations in MCP and controller
```

MCP 容器内挂载：

```text
/data/vault
/mutations
```

全权限 profile 还把同一个 PVC 的 `.audit` 子目录挂载到：

```text
/data/audit
```

因此审计日志实际落在 vault PVC 里：

```text
.audit/obsidian-vault-mcp.audit.log
```

`MUTATION_QUEUE_DIR=/mutations` 会让 `vault_delete` 和 `vault_move` 先写 WAL mutation，再执行文件删除或移动。`/mutations` 不应放在 vault 内，也不应被 Obsidian/LiveSync 当普通笔记同步。

## LiveSync controller

controller 负责串行管理 LiveSync local DB：

```text
常规同步：启动 livesync-cli daemon
delete：livesync-cli rm path -> sync
move：livesync-cli rm oldPath -> push /vault/newPath newPath -> sync
```

不要同时运行旧的 `mirror -> sync -> mirror` 主循环，也不要再额外运行一个 sidecar 在 daemon 活跃时调用 `livesync-cli rm/push/sync`。`mirror` 只保留给人工初始化或维护窗口。

controller 镜像可用本仓库的 wrapper Dockerfile 构建：

```bash
docker build \
  -f livesync-controller/Dockerfile \
  --build-arg LIVESYNC_CLI_IMAGE=YOUR_LIVESYNC_CLI_IMAGE \
  -t ghcr.io/3011/obsidian-livesync-controller:main \
  livesync-controller
```

## 恢复能力

`personal-full-access` 默认启用：

```text
TRASH_DELETE=true
BACKUP_BEFORE_WRITE=true
```

效果：

- `vault_delete` 不直接永久删除，而是移动到 `.trash/`
- `vault_write`、`vault_append`、`vault_patch`、`vault_move`、`vault_delete` 前会按需写 `.backups/`
- 启用 `MUTATION_QUEUE_DIR` 后，`vault_delete` 和 `vault_move` 会额外写 mutation WAL，供 LiveSync controller 提交 DB 删除/移动语义
- `.trash/` 和 `.backups/` 默认被 MCP 路径保护逻辑屏蔽，不能通过普通 note 工具读取或改写

生产切换前建议实际演练一次：

```text
写入测试文件 -> 删除 -> 从 .trash/ 或 .backups/ 手动恢复 -> 验证 LiveSync 同步状态
```

## 已验证状态

当前项目已在隔离测试环境验证：

- LiveSync CLI daemon + CouchDB 测试库
- OpenAI Secure MCP Tunnel
- ChatGPT 网页 Connector
- `vault_list`
- `vault_read`
- `vault_write`
- `vault_append`
- `vault_patch`
- `vault_delete`
- `vault_move`
- `search_simple`
- `tag_list`
- `append_to_inbox`
- `vault_upload_image_asset`
- `vault_create_note_with_assets`
- `vault_create_external_reference_note`

生产切换前仍建议：

- 使用不可变镜像 tag 或 digest
- 轮换测试期间暴露过的 OpenAI runtime API key
- 备份正式 LiveSync CouchDB 数据库
- 先在 vault 副本上跑一轮完整工具矩阵
