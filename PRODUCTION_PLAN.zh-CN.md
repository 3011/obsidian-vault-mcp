# 生产就绪计划

[English](PRODUCTION_PLAN.md)

当前项目已经可以作为 alpha 阶段的无头文件系统 Obsidian Vault MCP Server 使用。目标是让它足够安全、可维护，可以作为生产级开源项目发布和运行。

## P0：协议兼容性

- [x] 增加基于官方 `@modelcontextprotocol/sdk` client 的兼容性测试。
- [x] 验证 `initialize`、`tools/list`、`tools/call` 和 client close 行为。
- 使用 MCP Inspector 验证。
- [x] 通过 OpenAI Secure MCP Tunnel 验证 ChatGPT Connector。
- [x] 在 README 中维护协议兼容性矩阵。

## P0：数据安全

- [x] 为 write、append、patch、move、delete 增加 per-file operation locks。
- [x] 增加可选 backup-before-write 模式。
- [x] 增加可选 trash delete 模式，避免直接永久删除。
- [x] 为所有 mutating tools 增加结构化审计日志，并支持可选 JSONL 文件输出。
- [x] 增加危险工具开关和 read-only 模式。

## P1：Markdown 正确性

- [x] 用成熟 YAML parser 替换 YAML 子集 parser。
- [x] 增加 CRLF、Unicode headings、fenced code block 内 heading、tables、block references、复杂 frontmatter 测试。
- [x] 依赖 `markdown-patch`，更接近 Local REST API 的 patch 语义。
- [x] 增加 duplicate heading 测试并记录当前行为。

## P1：搜索和索引

- 增加可配置搜索限制和超时。
- 为大 vault 增加可选缓存索引。
- 基于文件 mtime 增量刷新索引。
- 为大结果集增加分页。

## P1：运维加固

- [x] 增加 request body size limits。
- 增加 rate limiting。
- 增加 `/readyz`，检查 vault 可写性。
- 增加 request count、errors、latency、mutating operations metrics。
- 增加 Docker image labels 和 release metadata。

## P1：LiveSync 运行时集成

- [x] 构建并 smoke-test 固定版本的 LiveSync CLI 镜像。
- [x] 使用隔离 CouchDB 数据库和隔离 CouchDB 用户验证 LiveSync CLI。
- [x] 验证 `put -> sync -> sync -> mirror -> /vault Markdown` one-shot flow。
- [x] 使用共享测试 vault PVC 验证 LiveSync daemon。
- [x] 验证 MCP `vault_write -> shared /vault -> LiveSync daemon -> CouchDB -> clean CLI mirror` roundtrip。
- [x] 将 LiveSync 和 MCP shared-vault 权限统一到 uid/gid `1000`，并使用 `fsGroup=1000`。
- [x] 初始生产使用保守 polling profile：`CHOKIDAR_USEPOLLING=true`、`CHOKIDAR_INTERVAL=1000`、`--interval 5` 或 `--interval 10`。
- 在节点 inotify sysctl 持久提高并验证后，再把 `inotify + _changes feed` 作为后续优化目标。
- [x] 把临时验证过的 LiveSync/MCP manifests 转换为已纳入仓库的 k3s deployment profile。

## P1：TypeScript 和 CI

- [x] 用 `tsc` build output under `dist/` 替换运行时 type stripping。
- [x] 增加 `tsconfig.json`。
- [x] 增加 lint。
- 增加 formatting。
- [x] 增加 GitHub Actions：typecheck、tests、Docker build。
- [x] 增加 GitHub Actions：发布镜像到 GHCR。
- 增加 Dependabot 或 Renovate 配置。

## P2：开源发布材料

- [x] 增加 `LICENSE`。
- [x] 扩展 README，包含工具说明、示例、安全模型、部署指南。
- [x] 增加 `CONTRIBUTING.md`。
- [x] 增加 `SECURITY.md`。
- 增加 release notes 和 semantic versioning。
- [x] 发布 branch、tag、sha Docker images，而不是只使用 `:dev`。

## 当前下一步

alpha 源码已经发布到 `git@github.com:3011/obsidian-vault-mcp.git` 的 `main` 分支。

发布前已验证：

- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `docker build -t obsidian-vault-mcp:ci .`

运行时验证状态：

- MCP full-access/noauth deployment 已在私有 k3s 环境验证。
- Trash delete、backup-before-write、image asset tools、external reference notes、file audit logging 已验证。
- 曾用 Cloudflare quick tunnel 验证到 `/mcp` 的临时 HTTPS tunnel 连通性，之后已移除。
- LiveSync 已使用隔离测试资源验证，包括完整 MCP-to-CouchDB roundtrip。
- OpenAI Secure MCP Tunnel doctor 已针对集群内 MCP Service URL 验证。
- 长运行 tunnel-client Deployment 已在 k3s 验证；ChatGPT-side connector validation 已通过。
- 已验证的网络模式是：MCP 到集群内 Service 的流量保持 direct。如果集群访问 tunnel control-plane 需要 outbound proxy，应在运行环境中配置该值。
- 已纳入仓库的 k3s profile 已更新为验证过的 Node MCP + LiveSync polling + private tunnel 架构，并且剩余 MCP 工具矩阵已通过直接 k3s MCP 验证。
- ChatGPT 网页通过 `tunnel` MCP connector 已验证 `vault_append`、`vault_patch`、`vault_move`、`search_simple`、`tag_list`、`append_to_inbox`、`vault_upload_image_asset`、`vault_create_note_with_assets`、`vault_create_external_reference_note`。

下一步是把已验证的私有 profile 推向生产：从本地开发镜像切换到不可变 GHCR tag 或 digest，轮换 runtime keys，从 `.trash/` 和 `.backups/` 做恢复演练，然后在备份正式 LiveSync 数据库后规划从隔离测试数据库切换到真实 vault 数据库。
