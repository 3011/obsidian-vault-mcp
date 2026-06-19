# Production Readiness Plan

[中文文档](PRODUCTION_PLAN.zh-CN.md)

This project is currently usable as an alpha headless filesystem Obsidian Vault MCP server. The goal is to make it safe to publish and operate as a production-grade open source project.

## P0: Protocol Compatibility

- [x] Add compatibility tests using the official `@modelcontextprotocol/sdk` client.
- [x] Verify `initialize`, `tools/list`, `tools/call`, and client close behavior.
- Validate with MCP Inspector.
- [x] Validate with ChatGPT Connector through OpenAI Secure MCP Tunnel.
- [x] Keep a protocol compatibility matrix in the README.

## P0: Data Safety

- [x] Add per-file operation locks for write, append, patch, move, and delete.
- [x] Add optional backup-before-write mode.
- [x] Add optional trash mode for delete instead of permanent removal.
- [x] Add structured audit logs for all mutating tools, with optional JSONL file output.
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

## P1: LiveSync Runtime Integration

- [x] Build and smoke-test a LiveSync CLI image: `10.10.0.1:30500/obsidian-livesync-cli:pin-20260618`.
- [x] Validate LiveSync CLI against an isolated CouchDB database and isolated CouchDB user.
- [x] Validate `put -> sync -> sync -> mirror -> /vault Markdown` one-shot flow.
- [x] Validate LiveSync daemon with a shared test vault PVC.
- [x] Validate MCP `vault_write -> shared /vault -> LiveSync daemon -> CouchDB -> clean CLI mirror` roundtrip.
- [x] Standardize LiveSync and MCP shared-vault permissions on uid/gid `1000` with `fsGroup=1000`.
- [x] Use the conservative polling profile for initial production: `CHOKIDAR_USEPOLLING=true`, `CHOKIDAR_INTERVAL=1000`, and `--interval 5` or `--interval 10`.
- Keep `inotify + _changes feed` as the later optimization target after node inotify sysctls are persistently raised and validated.
- [x] Convert the temporary tested LiveSync/MCP manifests into the checked-in k3s deployment profile.

## P1: TypeScript and CI

- [x] Replace runtime type stripping with `tsc` build output under `dist/`.
- [x] Add `tsconfig.json`.
- [x] Add lint.
- Add formatting.
- [x] Add GitHub Actions for typecheck, tests, and Docker build.
- [x] Add GitHub Actions image publish to GHCR.
- Add Dependabot or Renovate config.

## P2: Open Source Packaging

- [x] Add `LICENSE`.
- [x] Expand README with tool reference, examples, security model, and deployment guides.
- [x] Add `CONTRIBUTING.md`.
- [x] Add `SECURITY.md`.
- Add release notes and semantic versioning.
- [x] Publish branch, tag, and sha Docker images instead of only `:dev`.

## Current Next Step

The sanitized alpha source has been published to `git@github.com:3011/obsidian-vault-mcp.git` on `main`.

Validated before publish:

- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `docker build -t obsidian-vault-mcp:ci .`

Runtime validation status:

- MCP full-access/noauth deployment has been validated in k3s `dev`.
- Trash delete, backup-before-write, image asset tools, external reference notes, and file audit logging have been validated.
- Temporary HTTPS tunnel connectivity to `/mcp` has been validated with a Cloudflare quick tunnel and then removed.
- LiveSync has been validated against isolated test resources, including a full MCP-to-CouchDB roundtrip.
- OpenAI Secure MCP Tunnel doctor has been validated against `obsidian-vault-mcp-livesync-test.dev.svc.cluster.local/mcp`.
- A long-running `openai-mcp-tunnel-client` Deployment is running in k3s `dev`; ChatGPT-side connector validation has passed.
- The k3s tunnel-client pod needs `CONTROL_PLANE_HTTP_PROXY=http://10.10.0.1:30800` for OpenAI control-plane egress in the current network. MCP traffic to the in-cluster Service remains direct.
- The checked-in dev k3s profile has been updated to the validated Node MCP + LiveSync polling + OpenAI Secure MCP Tunnel architecture, and the remaining MCP tool matrix has passed direct k3s MCP validation.
- ChatGPT web testing through the `tunnel` MCP connector passed for `vault_append`, `vault_patch`, `vault_move`, `search_simple`, `tag_list`, `append_to_inbox`, `vault_upload_image_asset`, `vault_create_note_with_assets`, and `vault_create_external_reference_note`.

The immediate next step is to promote the validated dev profile toward production: switch from local `:dev` images to immutable GHCR tags or digests, rotate the OpenAI runtime key, perform a restore drill from `.trash/` and `.backups/`, then plan the cutover from the isolated LiveSync test database to the real vault database with a backup.
