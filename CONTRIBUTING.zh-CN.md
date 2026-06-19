# 贡献指南

[English](CONTRIBUTING.md)

## 开发环境

使用 Node.js 22 或更新版本。

```bash
npm ci
npm run typecheck
npm test
```

开发时可以运行更聚焦的测试组：

```bash
npm run test:integration
npm run test:concurrency
npm run test:markdown
npm run test:sdk
```

## Pull Request

请保持改动范围清晰，行为变更需要补测试。

提交 PR 前请运行：

```bash
npm run typecheck
npm test
docker build -t obsidian-vault-mcp:ci .
```
