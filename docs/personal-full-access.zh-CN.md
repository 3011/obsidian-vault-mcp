# 个人全权限 Tunnel Profile

[English](personal-full-access.md)

这个 profile 面向单人自用场景：你明确希望 ChatGPT 通过 OpenAI Secure MCP Tunnel 或其他私有 tunnel 获得 Obsidian vault 的完整工具权限。

它会关闭 MCP Server 自身认证，因为网络信任边界放在 tunnel 上：

```text
ChatGPT -> OpenAI tunnel endpoint -> tunnel client -> Kubernetes Service -> obsidian-vault-mcp
```

只有在 MCP endpoint 不会作为无认证公网 HTTP 服务暴露时，才应该使用这个 profile。

## 服务配置

```bash
MCP_REQUIRE_TOKEN=false
READ_ONLY=false

ENABLE_VAULT_WRITE=true
ENABLE_VAULT_APPEND=true
ENABLE_VAULT_PATCH=true
ENABLE_VAULT_DELETE=true
ENABLE_VAULT_MOVE=true
ENABLE_APPEND_TO_INBOX=true
ENABLE_FILE_TRANSFER=true
MAX_FILE_TRANSFER_BYTES=268435456
MAX_EMBEDDED_EXPORT_BYTES=4194304
FILE_TRANSFER_TIMEOUT_SECONDS=600
FILE_IMPORT_ALLOWED_HOSTS=.blob.core.windows.net,.oaiusercontent.com
ENABLE_EXTERNAL_REFERENCE_NOTES=true

ENABLE_AUDIT_LOG=true
AUDIT_LOG_PATH=/data/audit/obsidian-vault-mcp.audit.log

TRASH_DELETE=true
TRASH_DIR=.trash
BACKUP_BEFORE_WRITE=true
BACKUP_DIR=.backups
```

这些配置会暴露所有工具：

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
vault_import_file
vault_export_file
vault_create_external_reference_note
```

## Kubernetes

部署全权限服务 profile：

```bash
kubectl -n YOUR_NAMESPACE apply -k deploy/personal-full-access
kubectl -n YOUR_NAMESPACE rollout status deploy/obsidian-vault-mcp
```

按 OpenAI tunnel 配置流程启动 tunnel client，并把 upstream MCP URL 指向：

```text
http://obsidian-vault-mcp:80/mcp
```

Service 故意使用 `ClusterIP`，只应该在集群内部访问。

## 运维注意事项

这个模式权限很高。服务仍会阻止路径穿越、symlink 逃逸、敏感 vault 内部目录、隐式创建父目录，以及未受保护地覆盖已变化文件。GPT 可以操作允许范围内的 Markdown 文件，也可以通过专用的受限文件传输工具导入/导出任意允许的文件类型。

默认情况下，删除会移动到 `.trash/`，并且在 write、append、patch、move、delete 前会把已有笔记复制到 `.backups/`。这两个恢复目录都会被 MCP note 访问逻辑屏蔽。

在接入主 vault 前：

- 保持 Obsidian LiveSync 或其他备份/同步历史开启；
- 保持审计日志开启；
- 先在 vault 副本上测试；
- 日常捕获优先用 `append_to_inbox`；
- 实际文件需要进入 Vault 时使用 `vault_import_file`；要求原始字节严格一致时同时提供 `expectedSha256` 和 `expectedSize`；
- 覆盖已有不同内容时必须同时提供 `allowOverwrite=true` 和当前目标的 `expectedDestinationSha256`；
- PDF、Office、压缩包、大日志等若仍由 NAS/云盘/工单系统管理，优先用 `vault_create_external_reference_note` 只记录引用；
- `vault_export_file` 的 embedded 导出硬上限为 4 MiB；
- ChatGPT UI 出现破坏性工具确认时，仔细检查调用内容。

自动化测试已经覆盖通用 import/export 完整性、覆盖保护、大小上限、路径/symlink 边界、embedded-resource 返回和 SDK 兼容性。部署新镜像后应重新跑一次 ChatGPT tunnel 实测矩阵。切换主 vault 前，仍然建议从 `.trash/` 和 `.backups/` 做一次恢复演练，并轮换测试期间暴露过的 runtime API key。
