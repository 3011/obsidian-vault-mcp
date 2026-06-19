# 安全策略

[English](SECURITY.md)

## 支持版本

在项目开始发布正式 tag 版本前，安全修复暂时只在 `main` 分支处理。

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
