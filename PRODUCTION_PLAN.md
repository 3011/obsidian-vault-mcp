# Production Readiness Plan

This project is currently usable as an alpha headless filesystem Obsidian Vault MCP server. The goal is to make it safe to publish and operate as a production-grade open source project.

## P0: Protocol Compatibility

- [x] Add compatibility tests using the official `@modelcontextprotocol/sdk` client.
- [x] Verify `initialize`, `tools/list`, `tools/call`, and client close behavior.
- Validate with MCP Inspector.
- Validate with ChatGPT Connector against a public HTTPS `/mcp` endpoint.
- Keep a protocol compatibility matrix in the README.

## P0: Data Safety

- [x] Add per-file operation locks for write, append, patch, move, and delete.
- Add optional backup-before-write mode.
- Add optional trash mode for delete instead of permanent removal.
- [x] Add structured audit logs for all mutating tools.
- [x] Add configurable dangerous tool toggles and read-only mode.

## P1: Markdown Correctness

- [x] Replace the YAML subset parser with a mature YAML parser.
- [x] Add tests for CRLF, Unicode headings, headings inside fenced code blocks, tables, block references, and complex frontmatter.
- [x] Depend on `markdown-patch` for closer Local REST API patch semantics.
- [x] Add duplicate heading tests and document current behavior.

## P1: Search and Indexing

- Add configurable search limits and timeouts.
- Add an optional cached index for large vaults.
- Add incremental index refresh based on file mtimes.
- Add pagination for large result sets.

## P1: Operational Hardening

- [x] Add request body size limits.
- Add rate limiting.
- Add `/readyz` with vault writeability checks.
- Add metrics for request count, errors, latency, and mutating operations.
- Add Docker image labels and release metadata.

## P1: TypeScript and CI

- [x] Replace runtime type stripping with `tsc` build output under `dist/`.
- [x] Add `tsconfig.json`.
- [x] Add lint.
- Add formatting.
- [x] Add GitHub Actions for typecheck, tests, and Docker build.
- Add GitHub Actions image publish.
- Add Dependabot or Renovate config.

## P2: Open Source Packaging

- [x] Add `LICENSE`.
- [x] Expand README with tool reference, examples, security model, and deployment guides.
- [x] Add `CONTRIBUTING.md`.
- [x] Add `SECURITY.md`.
- Add release notes and semantic versioning.
- Publish tagged Docker images instead of only `:dev`.

## Current Next Step

The immediate next step is a publish pass: run full tests in a non-sandboxed environment, initialize the GitHub repository, push the sanitized alpha source, and then add trash/backup modes before publishing beyond alpha.
