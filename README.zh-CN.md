# Obsidian Vault MCP

[English](README.md)

这是一个无头 Obsidian Vault MCP Server，后端是普通 Markdown vault 目录。

它的目标链路是：

```text
livesync-cli daemon -> /data/vault -> obsidian-vault-mcp -> ChatGPT Connector
```

它不依赖 Obsidian GUI、插件 API、命令面板、活动文件或桌面状态。

## 工具列表

- `vault_list`：列出 vault 文件和目录。
- `vault_list_detailed`：返回结构化路径事实、文件元数据、附件标记、warnings 和 scan ID。
- `vault_read`：读取完整笔记元数据/内容，或读取 heading、block、frontmatter 目标；也可读取支持的文本文件。
- `vault_write`：创建或覆盖 Markdown 文件。
- `vault_append`：追加 Markdown 内容，文件不存在时自动创建。
- `vault_patch`：patch heading、block 或 frontmatter 目标。
- `vault_delete`：删除 vault 文件或空目录。
- `vault_move`：移动或重命名 vault 文件。
- `vault_get_document_map`：列出 headings、block refs、frontmatter fields、links、embeds 和 tags。
- `search_simple`：全 vault 简单字符串搜索，返回上下文。
- `search_query`：按 path glob、tag、frontmatter 等值和内容子串搜索 Markdown。
- `find_asset_references`：只读分析一个或多个附件路径的 Markdown 引用关系，并返回保守的 `trashSafety`。
- `asset_audit`：只读目录级附件审计，组合详细列表和引用分析结果。
- `tag_list`：列出 tags 和计数，包含 nested tag 的父级计数。
- `append_to_inbox`：追加内容到默认 inbox 目录下的笔记。
- `vault_upload_image_asset`：上传小型图片资产，并返回 Obsidian embed 链接。
- `vault_create_note_with_assets`：创建 Markdown 笔记，同时把图片资产保存到笔记旁边。
- `vault_create_external_reference_note`：创建外部材料引用笔记，不上传原始文件。

破坏性工具是可以启用的，因为该项目支持个人全权限 tunnel 场景。但服务仍会阻止绝对路径、`..`、symlink escape、临时文件和敏感目录，例如 `.obsidian/`、`.livesync/`、`.git/`、`.trash/`、`node_modules/`。

## 实现说明

- `vault_read` 对 Markdown 文件返回内容、frontmatter、tags、文件 stat、links 和 embeds，也可以读取 heading、nested heading path、block reference 或 frontmatter field。对非 Markdown 文本文件返回 content 和 stat；二进制文件会被拒绝。
- `vault_list_detailed` 会区分路径不存在、文件、空目录、非空目录、被拒绝路径和被跳过条目。它支持递归，并可选计算 SHA-256。
- `find_asset_references` 支持 Obsidian wikilink、Markdown image link 和常见 HTML `<img src>` 引用。它会忽略 fenced code block 和 inline code，并返回 `scanCompleteness`、`candidateOrphan`、`trashSafety`、证据和 warnings。
- `asset_audit` 是只读工具，不会移动、删除或改写文件。它组合 `vault_list_detailed` 和 `find_asset_references`；`candidateOrphan=true` 只表示没有发现支持范围内的结构化引用，而 `trashSafety=safe` 只会在 full-vault 扫描且无引用、无歧义、无 unresolved/unsupported match、无同名重复、无相关 warning 时返回。不确定场景返回 `trashSafety=unknown`。
- `vault_write` 使用原子写入创建或覆盖 Markdown 文件。
- `vault_append` 会保留已有内容，文件不存在时创建文件。
- `vault_patch` 支持 heading、block、frontmatter 目标，操作包括 `replace`、`prepend`、`append`；也支持 `createTargetIfMissing`、`rejectIfContentPreexists`、`trimTargetWhitespace`、`targetDelimiter`、`contentType` 和 `targetScope`。
- duplicate heading path 当前遵循 `markdown-patch` 的 map 行为：后匹配的 heading 会胜出。使用 `vault_patch` 时建议保持 heading path 唯一，或传入更具体的 nested path。
- `vault_delete` 支持删除 vault 文件和空目录，非空目录会被拒绝。
- `vault_move` 支持 vault 文件移动，destination 以 `/` 结尾表示目标目录，并支持可选 overwrite。它不允许在 Markdown 和非 Markdown 扩展之间互相改名。
- `vault_upload_image_asset` 只接受 PNG、JPEG、WebP、GIF，会校验 MIME、扩展名、大小、基础 magic bytes，并要求目标目录名为 `assets`。
- `vault_upload_image_asset` 和 `vault_create_note_with_assets` 支持可选 `expectedSha256`、`expectedSize`、`preserveOriginal` 字段。需要证明原始字节无损保存时建议使用这些字段。
- `vault_create_note_with_assets` 把图片保存到 note-local `assets/` 目录，并把 `{{asset:n}}` 占位符替换为 Obsidian embed。
- `vault_create_external_reference_note` 用于 NAS、云盘、工单、PDF、Word、Excel、zip、日志包等不应该进入 vault 的原始材料。
- `search_simple` 按文件返回所有匹配和上下文。
- `search_query` 按 path glob、tag、frontmatter 等值和内容子串过滤 Markdown 文件。
- `tag_list` 扫描 frontmatter tags 和 inline tags，并统计 nested tag 的父级。

## 图片完整性

日常截图可以只传 `filename`、`mimeType` 和 `contentBase64`。服务端会返回解码后的 `bytes`、`sha256`、`mimeType` 和 `integrity` 对象。

需要原始文件无损保存时，调用方应该传入：

```json
{
  "filename": "original.png",
  "mimeType": "image/png",
  "contentBase64": "...",
  "expectedSha256": "1f3373db406b302e25912db5f23a01777a53f6aba588fcd06846a7d32db9411b",
  "expectedSize": 91353,
  "preserveOriginal": true
}
```

默认 `IMAGE_ASSET_INTEGRITY_MODE=required_for_preserve_original`。此模式下，只要 `preserveOriginal=true`，就必须提供 `expectedSha256` 和 `expectedSize`；任一值不匹配都会在写入前拒绝。

## 运行

```bash
mkdir -p /tmp/vault/98-Inbox/assets
npm run build
MCP_TOKEN=change-me VAULT_ROOT=/tmp/vault npm start
```

配置的 Inbox 和默认附件目录必须预先存在。笔记写入工具不会隐式创建父目录。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MCP_HOST` | `0.0.0.0` | 监听地址。 |
| `MCP_PORT` | `8080` | 监听端口。 |
| `MCP_PATH` | `/mcp` | Streamable HTTP MCP endpoint。 |
| `MCP_TOKEN` | empty | Bearer token。 |
| `MCP_TOKEN_FILE` | empty | Bearer token 文件路径。 |
| `MCP_REQUIRE_TOKEN` | `true` | 是否要求 Bearer token。 |
| `MCP_PUBLIC_BASE_URL` | empty | metadata 响应使用的 public base URL。 |
| `MCP_ALLOWED_ORIGINS` | empty | CORS allowlist，逗号分隔；`*` 表示允许全部。 |
| `VAULT_ROOT` | `/data/vault` | Markdown vault 根目录。 |
| `MUTATION_QUEUE_DIR` | empty | 可选的 LiveSync delete/move mutation intent WAL 绝对路径，不能位于 `VAULT_ROOT` 内。 |
| `DEFAULT_WRITE_DIR` | `98-Inbox` | `append_to_inbox` 使用的现有 Inbox 目录；工具启用时若目录不存在，服务启动失败。 |
| `WRITE_ALLOWED_ROOTS` | empty | 可选的一级写入目录白名单，逗号分隔。为空时允许任意已存在的一级目录，但仍禁止直接写 Vault 根目录。 |
| `MAX_REQUEST_BYTES` | `16777216` | JSON 请求体大小限制，需要大于 base64 图片资产大小。 |
| `READ_ONLY` | `false` | 为 true 时隐藏所有 mutating tools。 |
| `ENABLE_VAULT_WRITE` | `true` | 暴露 `vault_write`。 |
| `ENABLE_VAULT_APPEND` | `true` | 暴露 `vault_append`。 |
| `ENABLE_VAULT_PATCH` | `true` | 暴露 `vault_patch`。 |
| `ENABLE_VAULT_DELETE` | `true` | 暴露 `vault_delete`。 |
| `ENABLE_VAULT_MOVE` | `true` | 暴露 `vault_move`。 |
| `ENABLE_APPEND_TO_INBOX` | `true` | 暴露 `append_to_inbox`。 |
| `ENABLE_IMAGE_ASSETS` | `true` | 暴露图片资产上传和图文笔记工具。 |
| `ENABLE_EXTERNAL_REFERENCE_NOTES` | `true` | 暴露外部引用笔记创建工具。 |
| `ASSETS_DIR_NAME` | `assets` | note-local 图片资产目录名。 |
| `MAX_IMAGE_ASSET_BYTES` | `10485760` | 图片资产解码后最大字节数。 |
| `ALLOWED_IMAGE_MIME_TYPES` | `image/png,image/jpeg,image/webp,image/gif` | 图片 MIME allowlist，逗号分隔。 |
| `IMAGE_ASSET_INTEGRITY_MODE` | `required_for_preserve_original` | 图片完整性策略：`optional`、`required_for_preserve_original` 或 `required`。 |
| `ENABLE_AUDIT_LOG` | `true` | 把 mutating operations 记录为 JSON。 |
| `AUDIT_LOG_PATH` | empty | 可选 JSONL 审计日志文件路径；为空时输出到 stdout。 |
| `TRASH_DELETE` | `true` | 删除时把 vault 文件移动到 trash 目录，而不是永久删除。 |
| `TRASH_DIR` | `.trash` | 删除恢复目录。 |
| `BACKUP_BEFORE_WRITE` | `true` | write、append、patch、move、delete 前备份已有 vault 文件。 |
| `BACKUP_DIR` | `.backups` | 备份恢复目录。 |

## 安全模型

服务允许在启用时暴露破坏性工具，但始终执行基础文件安全约束：

- 不允许绝对路径；
- 不允许 `..` 路径穿越；
- 不允许 symlink 逃出 vault root；
- 不允许访问 `.obsidian/`、`.livesync/`、`.git/`、`.trash/`、`.backups`、`node_modules/`；
- 不允许临时/交换文件；
- 禁止直接写入 Vault 根目录；
- 笔记、附件和移动工具不会隐式创建父目录；
- 可通过 `WRITE_ALLOWED_ROOTS` 限制允许写入的一级目录；
- 相应工具启用时，启动阶段会校验 Inbox 和默认附件目录已经存在；
- 不支持任意附件上传，只允许小型图片资产作为 vault 文件；
- write、append、patch、move、delete 使用 per-file lock；
- 原子写入使用临时文件、fsync 和 rename；
- 默认 trash delete 和 backup-before-write；
- mutating operations 使用 JSON 审计日志。

## 测试

```bash
npm run typecheck
npm test
```

测试套件会启动 HTTP MCP Server，并覆盖所有暴露工具、认证失败、路径穿越拒绝、敏感目录拒绝、symlink escape 拒绝、缺失父目录时拒绝且不创建目录、Vault 根目录写入拒绝、一级写入白名单、overwrite move、patch variants、图片资产校验、外部引用笔记创建、search 多匹配、tag 聚合。

还包含官方 `@modelcontextprotocol/sdk` Streamable HTTP client 兼容测试，会连接 `/mcp`、列出工具，并调用 `vault_read`、`vault_write`、`search_simple`。

额外拆分测试覆盖 per-file 并发 append lock，以及 Markdown/YAML 边界：复杂 frontmatter、Unicode headings、fenced code blocks 内 heading、duplicate heading、CRLF 输入、通过 `markdown-patch` patch 表格。

## 协议兼容性

已测试：

- `@modelcontextprotocol/sdk` `^1.29.0`
- Streamable HTTP client transport
- Bearer token authentication
- OpenAI Secure MCP Tunnel + ChatGPT Connector，个人 full-access k3s 部署

支持的 JSON-RPC methods：

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

## 构建

```bash
docker build -t ghcr.io/3011/obsidian-vault-mcp:main .
docker push ghcr.io/3011/obsidian-vault-mcp:main
```

GitHub Actions 会在 push 到 `main` 和 git tag 时发布镜像到 `ghcr.io/3011/obsidian-vault-mcp`，并发布不可变 `sha-*` tag。

## Kubernetes 示例

拆分后的 manifests 和中文部署说明在 `deploy/` 下，见 `deploy/README.zh-CN.md`。
推荐的 LiveSync + MCP + private tunnel 拓扑见 `docs/deployment-architecture.zh-CN.md`。

```bash
kubectl -n YOUR_NAMESPACE create secret generic obsidian-vault-mcp-token \
  --from-literal=MCP_TOKEN="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n YOUR_NAMESPACE apply -k deploy/default
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

## 个人全权限 Tunnel

如果是纯个人使用，并且你有意让 ChatGPT 使用所有 vault 工具，可以使用 full-access tunnel profile：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

这个 profile 设置 `MCP_REQUIRE_TOKEN=false`、`READ_ONLY=false`，并启用 write、append、patch、delete、move、inbox append、image asset、external reference note tools。它假设 MCP Server 只通过 OpenAI Secure MCP Tunnel 这类私有 tunnel 访问，tunnel upstream 指向：

```text
http://obsidian-vault-mcp:80/mcp
```

在主 vault 上使用前，请先阅读 `docs/personal-full-access.zh-CN.md`。

运行时验证已在隔离部署 profile 中完成，包含 LiveSync CLI、CouchDB、OpenAI Secure MCP Tunnel 和 ChatGPT Connector。ChatGPT 侧 tunnel 工具矩阵已通过：`vault_list`、`vault_read`、`vault_write`、`vault_append`、`vault_patch`、`vault_delete`、`vault_move`、`search_simple`、`tag_list`、`append_to_inbox`、`vault_upload_image_asset`、`vault_create_note_with_assets`、`vault_create_external_reference_note`。
