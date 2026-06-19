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
ENABLE_IMAGE_ASSETS=true
ENABLE_EXTERNAL_REFERENCE_NOTES=true
ASSETS_DIR_NAME=assets
MAX_IMAGE_ASSET_BYTES=10485760
ALLOWED_IMAGE_MIME_TYPES=image/png,image/jpeg,image/webp,image/gif

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
vault_upload_image_asset
vault_create_note_with_assets
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

这个模式权限很高。服务仍会阻止路径穿越、symlink 逃逸、敏感 vault 内部目录、任意附件上传和非图片资产写入，但 GPT 可以创建、覆盖、patch、移动和删除允许范围内的 Markdown 文件，也可以保存小型图片资产。

默认情况下，删除会移动到 `.trash/`，并且在 write、append、patch、move、delete 前会把已有笔记复制到 `.backups/`。这两个恢复目录都会被 MCP note 访问逻辑屏蔽。

在接入主 vault 前：

- 保持 Obsidian LiveSync 或其他备份/同步历史开启；
- 保持审计日志开启；
- 先在 vault 副本上测试；
- 日常捕获优先用 `append_to_inbox`；
- PDF、Word、Excel、zip、大日志包优先用 `vault_create_external_reference_note` 只记录引用；
- 只有截图、架构图等小图片确实属于笔记内容时，才用 `vault_create_note_with_assets`；
- ChatGPT UI 出现破坏性工具确认时，仔细检查调用内容。

已验证的 k3s + ChatGPT tunnel 覆盖范围包括 list、read、write、append、patch、delete、move、search、tag listing、inbox append、image asset upload、note creation with assets 和 external reference note creation。切换主 vault 前，仍然建议从 `.trash/` 和 `.backups/` 做一次恢复演练，并轮换测试期间暴露过的 runtime API key。
