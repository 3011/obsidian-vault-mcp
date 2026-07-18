# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-07-18

### Added

- Safe Markdown vault operations exposed through Streamable HTTP MCP.
- Structured output schemas and tool annotations for all MCP tools.
- Create-only and revision-checked note mutation APIs.
- WAL-backed move/delete operations with a LiveSync controller.
- Asset integrity validation, asset auditing, recovery backups, trash deletes, and audit logging.
- Kubernetes deployment profiles for token-protected and personal full-access use.
- Automated CI, GHCR image publishing, Dependabot security updates, and GitHub Releases for `v*` tags.

### Changed

- Release automation now listens to both `main` and `v*` tag pushes.
- Deployment examples no longer contain a private internal registry address.
- Historical production-readiness plans moved from the repository root to `docs/history/`.

[Unreleased]: https://github.com/3011/obsidian-vault-mcp/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/3011/obsidian-vault-mcp/releases/tag/v0.2.3
