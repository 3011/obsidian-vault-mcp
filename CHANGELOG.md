# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Community code of conduct, structured bug and feature issue forms, and a pull request template.
- Dedicated CodeQL and Gitleaks workflows.
- Monthly grouped Dependabot version updates limited to compatible minor and patch releases.
- OCI image metadata linking the container package to this repository.

### Changed

- Updated the security policy to reflect tagged release support.

- Quick Start now builds the container locally so it works before the GHCR package is made public.

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
