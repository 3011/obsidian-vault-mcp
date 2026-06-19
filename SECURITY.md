# Security Policy

[中文文档](SECURITY.zh-CN.md)

## Supported Versions

Security fixes are currently handled on the `main` branch until the project starts publishing tagged releases.

## Reporting a Vulnerability

Please report vulnerabilities privately to the repository owner before opening a public issue.

## Deployment Notes

Run the service behind HTTPS when it is reachable outside a trusted network, set a strong `MCP_TOKEN`, and keep `MCP_REQUIRE_TOKEN=true`.

For shared or internet-facing deployments, consider disabling dangerous tools with:

```bash
ENABLE_VAULT_WRITE=false
ENABLE_VAULT_PATCH=false
ENABLE_VAULT_DELETE=false
ENABLE_VAULT_MOVE=false
```

Enable audit logging for production write paths:

```bash
ENABLE_AUDIT_LOG=true
AUDIT_LOG_PATH=/data/audit/obsidian-vault-mcp.audit.log
```
