# Obsidian Vault MCP

[English](README.md)

这是一个无头 Obsidian Vault MCP Server，后端是普通 Markdown vault 目录。

它的目标链路是：

```text
livesync-cli daemon -> /data/vault -> obsidian-vault-mcp -> ChatGPT Connector
```

它不依赖 Obsidian GUI、插件 API、命令面板、活动文件或桌面状态。

## 快速开始

克隆仓库并在本地构建镜像，然后启动服务：

```bash
git clone https://github.com/3011/obsidian-vault-mcp.git
cd obsidian-vault-mcp
docker build -t obsidian-vault-mcp:local .

mkdir -p "$HOME/obsidian-vault/98-Inbox"
export MCP_TOKEN="$(openssl rand -hex 32)"
docker run --rm --user "$(id -u):$(id -g)" -p 8080:8080 \
  -e MCP_TOKEN="$MCP_TOKEN" \
  -v "$HOME/obsidian-vault:/data/vault" \
  obsidian-vault-mcp:local
```

访问 `http://localhost:8080/healthz` 验证服务，然后在 MCP 客户端中配置端点 `http://localhost:8080/mcp`，Bearer Token 使用 `$MCP_TOKEN`。

Kubernetes 和 LiveSync 部署说明见 [`deploy/README.zh-CN.md`](deploy/README.zh-CN.md) 与 [`docs/deployment-architecture.zh-CN.md`](docs/deployment-architecture.zh-CN.md)。

## 工具列表

- `vault_list`：列出 vault 文件和目录。
- `vault_list_detailed`：返回结构化路径事实、文件元数据、附件标记、warnings 和 scan ID。
- `vault_read`：读取完整笔记元数据/内容，或读取 heading、block、frontmatter 目标；也可读取支持的文本文件。
- `vault_write`：兼容旧调用的 upsert 接口，已标记 deprecated。
- `vault_create_note`：原子创建新 Markdown 笔记，目标存在时拒绝覆盖。
- `vault_replace_note`：仅在原始字节 SHA-256 匹配时替换已有笔记。
- `vault_append`：追加 Markdown 内容，文件不存在时自动创建。
- `vault_patch`：patch heading、block 或 frontmatter 目标。
- `vault_delete`：删除 vault 文件或空目录。
- `vault_move`：移动或重命名 vault 文件。
- `vault_get_operation`：查询配置 WAL 后返回的 move/delete operation。
- `vault_get_document_map`：列出 headings、block refs、frontmatter fields、links、embeds 和 tags。
- `search_simple`：全 vault 简单字符串搜索，返回上下文。
- `search_query`：按 path glob、tag、frontmatter 等值和内容子串搜索 Markdown。
- `find_asset_references`：只读分析一个或多个附件路径的 Markdown 引用关系，并返回保守的 `trashSafety`。
- `asset_audit`：只读目录级附件审计，组合详细列表和引用分析结果。
- `tag_list`：列出 tags 和计数，包含 nested tag 的父级计数。
- `append_to_inbox`：追加内容到默认 inbox 目录下的笔记。
- `vault_import_file`：把 Host 提供的任意文件传入允许的 Vault 相对路径，并执行大小/SHA-256 校验与受保护覆盖。
- `vault_export_file`：把允许的 Vault 文件作为 embedded MCP 二进制 resource 返回给 Host 实体化。
- `vault_create_external_reference_note`：创建外部材料引用笔记，不上传原始文件。

破坏性工具是可以启用的，因为该项目支持个人全权限 tunnel 场景。但服务仍会阻止绝对路径、`..`、symlink escape、临时文件和敏感目录，例如 `.obsidian/`、`.livesync/`、`.git/`、`.trash/`、`node_modules/`。

## 实现说明

- `vault_read` 对完整文件读取返回内容、frontmatter、tags、文件 stat、links、embeds 和 `revision`。`revision.sha256` 直接对磁盘原始字节计算，不进行 Markdown、换行符或 Unicode 规范化。targeted read 保持原有目标值返回。
- `vault_list_detailed` 会区分路径不存在、文件、空目录、非空目录、被拒绝路径和被跳过条目。它支持递归，并可选计算 SHA-256。
- `find_asset_references` 支持 Obsidian wikilink、Markdown image link 和常见 HTML `<img src>` 引用。它会忽略 fenced code block 和 inline code，并返回 `scanCompleteness`、`candidateOrphan`、`trashSafety`、证据和 warnings。
- `asset_audit` 是只读工具，不会移动、删除或改写文件。它组合 `vault_list_detailed` 和 `find_asset_references`；`candidateOrphan=true` 只表示没有发现支持范围内的结构化引用，而 `trashSafety=safe` 只会在 full-vault 扫描且无引用、无歧义、无 unresolved/unsupported match、无同名重复、无相关 warning 时返回。不确定场景返回 `trashSafety=unknown`。
- `vault_write` 保留旧 upsert 行为；新调用优先使用 `vault_create_note` 或 `vault_replace_note`。`vault_create_note` 使用同目录临时文件和 hard-link no-replace 提交，避免并发创建覆盖。
- `vault_append` 会保留已有内容，文件不存在时创建文件；`expectedSha256` 可用于检测并发修改。
- `vault_patch` 支持 heading、block、frontmatter 目标，操作包括 `replace`、`prepend`、`append`；也支持 `createTargetIfMissing`、`rejectIfContentPreexists`、`trimTargetWhitespace`、`targetDelimiter`、`contentType` 和 `targetScope`。
- duplicate heading path 当前遵循 `markdown-patch` 的 map 行为：后匹配的 heading 会胜出。使用 `vault_patch` 时建议保持 heading path 唯一，或传入更具体的 nested path。
- `vault_delete` 支持删除 vault 文件和空目录，非空目录会被拒绝。配置 WAL 的文件删除返回 `operationId`；空目录删除或未配置 WAL 时同步完成且不生成临时 ID。
- `vault_move` 支持 vault 文件移动，destination 以 `/` 结尾表示目标目录，并支持可选 overwrite。overwrite 直接使用原子 rename，不再预先删除目标。配置 WAL 时返回 `operationId`，可用 `vault_get_operation` 查询。
- `vault_import_file` 不做 MIME 白名单限制。Host 授权的源文件会流式写入受限 spool，可选校验 `expectedSha256`/`expectedSize`，随后以原始字节原子提交到已有 Vault 目录。
- 覆盖不同内容时必须同时提供 `allowOverwrite=true` 和 `expectedDestinationSha256`；内容完全一致则视为幂等成功。开启 `BACKUP_BEFORE_WRITE=true` 时，覆盖前仍会备份旧文件。
- `vault_export_file` 返回 embedded MCP resource，并核对 SHA-256/大小。embedded export 硬上限为 4 MiB；超限直接失败，不截断，也不回退到公网 URL。
- `vault_create_external_reference_note` 用于 NAS、云盘、工单、PDF、Word、Excel、zip、日志包等不应该进入 vault 的原始材料。
- `search_simple` 按文件返回所有匹配和上下文。
- `search_query` 按 path glob、tag、frontmatter 等值和内容子串过滤 Markdown 文件。
- `tag_list` 扫描 frontmatter tags 和 inline tags，并统计 nested tag 的父级。

### 接口可靠性契约

- `tools/call` 的未知工具名和 inputSchema 校验失败统一返回 JSON-RPC `-32602`；工具开始执行后的领域错误返回 `isError=true` 和结构化 `error`。
- 修改已有文件时，`expectedSha256` 在同一路径锁内基于原始字节校验，并在实际修改后生成新 revision。当前锁为单 Node 进程锁，生产保持 MCP 单副本。
- WAL operation 的提交层级仅由事实字段判断：`remoteVerifiedAt` 表示 remote，`localCommittedAt` 表示 local；两者均不存在且 cancelled 表示 none，其他情况表示 unknown。
- `remote` 表示 Controller 完成 LiveSync 同步并通过同步后的 `livesync-cli info` 状态检查，不表示直接读取 CouchDB revision。
- `OPERATION_NOT_FOUND` 也可能表示记录已经超过保留期限或 WAL 存储不可用。

## 文件传输

`vault_import_file` 使用 Host 文件参数通道，而不是把 Base64 塞进普通 MCP 参数。在 ChatGPT 中，`tools/list` 会暴露 `_meta["openai/fileParams"] = ["file"]`，由 ChatGPT 提供授权的临时文件引用。服务端流式下载到受限 spool，计算 SHA-256 和字节数，再以原始字节提交到 Vault。

完整性敏感场景建议提供：

```json
{
  "file": "<host file>",
  "destination": "Projects/assets/original.pdf",
  "expectedSha256": "<64 位十六进制>",
  "expectedSize": 91353
}
```

覆盖已有不同内容时额外要求：

```json
{
  "file": "<host file>",
  "destination": "Projects/assets/original.pdf",
  "allowOverwrite": true,
  "expectedDestinationSha256": "<当前目标文件 SHA-256>"
}
```

`vault_export_file` 返回 embedded MCP 二进制 resource。由于 MCP `blob` 在协议层使用 Base64，且 Host 实体化存在实际大小边界，导出硬上限为 4 MiB；不会提供 resource-link/公网 URL 回退。

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
| `MAX_REQUEST_BYTES` | `16777216` | JSON 请求体大小限制；文件字节不再放入普通工具参数。 |
| `READ_ONLY` | `false` | 为 true 时隐藏所有 mutating tools。 |
| `ENABLE_VAULT_WRITE` | `true` | 暴露 `vault_write`。 |
| `ENABLE_VAULT_APPEND` | `true` | 暴露 `vault_append`。 |
| `ENABLE_VAULT_PATCH` | `true` | 暴露 `vault_patch`。 |
| `ENABLE_VAULT_DELETE` | `true` | 暴露 `vault_delete`。 |
| `ENABLE_VAULT_MOVE` | `true` | 暴露 `vault_move`。 |
| `ENABLE_VAULT_CREATE_DIRECTORY` | `true` | 暴露受控的单级目录创建能力。 |
| `ENABLE_APPEND_TO_INBOX` | `true` | 暴露 `append_to_inbox`。 |
| `ENABLE_FILE_TRANSFER` | `true` | 暴露 `vault_import_file` 与 `vault_export_file`；`READ_ONLY=true` 时隐藏 import，但保留 export。 |
| `MAX_FILE_TRANSFER_BYTES` | `268435456` | 导入文件最大大小，默认 256 MiB。 |
| `MAX_EMBEDDED_EXPORT_BYTES` | `4194304` | embedded export 上限；即使配置更大也硬限制为 4 MiB。 |
| `FILE_TRANSFER_SPOOL_DIR` | `/tmp/obsidian-vault-mcp-files` | 入站文件临时 spool 目录。 |
| `FILE_TRANSFER_TIMEOUT_SECONDS` | `600` | 源文件下载端到端超时。 |
| `FILE_IMPORT_ALLOWED_HOSTS` | empty | 可选下载 Host 白名单，支持 `.blob.core.windows.net` 这类后缀规则；留空允许任意 HTTPS Host。 |
| `FILE_IMPORT_ALLOW_HTTP` | `false` | 是否允许 HTTP 源 URL，仅建议本地测试使用。 |
| `ENABLE_EXTERNAL_REFERENCE_NOTES` | `true` | 暴露外部引用笔记创建工具。 |
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
- 显式的 `vault_create_directory` 每次只创建一级目录并要求填写理由，只应在检查现有目录后使用；父目录为空时可创建新的一级目录；
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

还包含官方 `@modelcontextprotocol/sdk` Streamable HTTP client 兼容测试，会验证 `outputSchema`、结构化成功输出，以及 `vault_read`、`vault_write`、`search_simple` 等调用。

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

GitHub Actions 会在 push 到 `main` 时发布 `main` 和不可变 `sha-*` 镜像。匹配 `v*` 的 tag 会发布 git tag、语义化版本别名、`latest`，并创建 GitHub Release。

> GitHub 个人账号下首次发布的 Container Registry 包默认为私有。要允许匿名拉取 `ghcr.io/3011/obsidian-vault-mcp`，需要在 GitHub Package settings 中把可见性改为 **Public**。

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

通用文件传输路径已由自动化测试覆盖：import/export 完整性、覆盖保护、大小限制、路径/符号链接边界、embedded resource 与 SDK 兼容性。部署新镜像后应重新跑一次 ChatGPT tunnel 实测矩阵。

## 项目历史

历史实施计划保留在 [`docs/history/`](docs/history/) 中作为设计背景；当前版本变化记录在 [`CHANGELOG.md`](CHANGELOG.md)。

## 参与贡献

提交 Pull Request 前请阅读 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。参与项目需遵守 [CODE_OF_CONDUCT.zh-CN.md](CODE_OF_CONDUCT.zh-CN.md)，安全问题请按照 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 报告。
