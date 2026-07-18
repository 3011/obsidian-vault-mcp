# 安全策略

[English](SECURITY.md)

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 最新 `0.2.x` release | 支持 |
| `main` | 支持 |
| 更早版本 | 不支持 |

## 漏洞报告

请先通过私有渠道向仓库所有者报告漏洞，不要直接创建公开 issue。

## 部署注意事项

如果服务会被可信网络外访问，请放在 HTTPS 后面，设置强 `MCP_TOKEN`，并保持：

```bash
MCP_REQUIRE_TOKEN=true
```

对于共享或公网部署，建议关闭危险工具：

```bash
ENABLE_VAULT_WRITE=false
ENABLE_VAULT_PATCH=false
ENABLE_VAULT_DELETE=false
ENABLE_VAULT_MOVE=false
```

生产写入路径建议开启审计日志：

```bash
ENABLE_AUDIT_LOG=true
AUDIT_LOG_PATH=/data/audit/obsidian-vault-mcp.audit.log
```
