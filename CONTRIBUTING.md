# Contributing

[中文文档](CONTRIBUTING.zh-CN.md)

## Development

Use Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
```

Run focused test groups while developing:

```bash
npm run test:integration
npm run test:concurrency
npm run test:markdown
npm run test:sdk
```

## Pull Requests

Keep changes scoped and include tests for behavior changes.

Before opening a pull request, run:

```bash
npm run typecheck
npm test
docker build -t obsidian-vault-mcp:ci .
```

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
