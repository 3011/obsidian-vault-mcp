# LiveSync Delete/Move Resurrection Report

[中文](livesync-delete-move-wal-report.zh-CN.md)

## Summary

In a headless Obsidian + LiveSync CLI + MCP deployment, `vault_move` could return successfully while both the source path and destination path later existed. Investigation confirmed that the MCP filesystem move succeeded; the source file was recreated later by LiveSync.

The root cause was not merely an incorrect sync order. Delete/move operations were not entering LiveSync/CouchDB as replicable mutation semantics. When a local file is deleted or moved only at the filesystem level, the old path can remain an active document in the LiveSync local DB or CouchDB. A later `mirror` or daemon initial mirror scan can restore that database-only active document back into the vault.

The implemented direction is:

```text
MCP writes /vault
MCP writes /mutations WAL
LiveSync controller serially consumes WAL
CouchDB receives deleted revisions
mirror leaves the daily sync path
```

## Symptom

Typical behavior:

```text
1. MCP vault_move oldPath -> newPath returns success
2. oldPath disappears briefly and newPath exists
3. LiveSync later recreates oldPath
4. oldPath and newPath both exist
```

This means `rename(2)` / Node `fs.rename` was not the failure point. The old path was missing a LiveSync DB delete semantic.

## Root Cause

LiveSync CLI `mirror` reconciles DB and storage differences. For database-only active files, `mirror` restores files from the DB to storage:

```text
local file missing
LiveSync DB still active
=> restore local file
```

That is the opposite of the user's intended "delete the old path" operation.

In CouchDB/LiveSync-style replication, deletion is not just a missing local file. It must be represented as a replicable deleted revision. Otherwise, other replicas still see the old document as active.

This path is therefore unreliable:

```text
MCP rm/mv local file
expect mirror to infer delete
```

The correct path is:

```text
MCP emits delete/move intent
LiveSync controller runs livesync-cli rm / push / sync
CouchDB replicates deleted revisions
```

## Investigation Findings

Confirmed facts:

- MCP and LiveSync are decoupled. MCP does not call `livesync-cli` directly and does not write CouchDB.
- MCP `vault_move` uses filesystem rename; when rename succeeds, the source path disappears immediately.
- Source-path resurrection happens after LiveSync synchronization.
- Changing the loop order to `mirror -> sync -> mirror` can mitigate some new-file cases, but it does not fix historical residue or downtime windows.
- Pure daemon/inotify is not complete either, because daemon startup still performs an initial mirror scan. MCP delete/move operations during downtime can still be restored.

## Fix Design

### Directory Separation

The target deployment uses three separate directories:

```text
/vault       Obsidian vault files
/data        LiveSync local DB / settings
/mutations   WAL shared by MCP and the controller
```

`/mutations` must not live inside the vault. It should not be indexed or synced as ordinary Obsidian content.

### MCP WAL

MCP adds:

```text
MUTATION_QUEUE_DIR=/mutations
```

When enabled, `vault_delete` and `vault_move` write WAL before mutating user paths:

```text
pending mutation
-> filesystem delete/move
-> ready mutation
```

If pending write fails, MCP refuses the file operation. This prevents "file changed but no mutation evidence" states.

### LiveSync Controller

The LiveSync path changes to a controller:

```text
livesync-controller
  -> starts livesync-cli daemon
  -> detects ready mutation
  -> stops daemon
  -> serially runs rm / push / sync
  -> moves mutation to done
  -> restarts daemon
```

The controller is the only execution path that writes the LiveSync local DB. Avoid this long-running pattern:

```text
livesync-cli daemon
+
another sidecar running livesync-cli rm/push/sync
```

That avoids concurrent processes writing the same LiveSync local DB state.

### Delete Semantics

```text
delete(path)
=> livesync-cli rm path
=> livesync-cli sync
=> path is no longer active
```

### Move Semantics

```text
move(oldPath, newPath)
=> livesync-cli rm oldPath
=> livesync-cli push /vault/newPath newPath
=> livesync-cli sync
=> oldPath deleted, newPath active
```

If MCP quickly performs `move -> delete`, the controller may process the move after `newPath` has already been moved away by delete. In that case, the controller treats the final state as:

```text
oldPath deleted
newPath deleted
```

This prevents rapid consecutive operations from getting stuck in `failed`.

## Implemented Changes

Code:

- Added `MutationJournal` for atomic pending/ready WAL writes.
- Wired `FsVault.delete` and `FsVault.move` into WAL.
- Added the `livesync-controller/controller.mjs` wrapper.
- Added `livesync-controller/Dockerfile`, based on the LiveSync CLI image.
- Added mutation and controller tests.

Deployment:

- Added an `obsidian-mutations` PVC.
- MCP mounts `/mutations` and sets `MUTATION_QUEUE_DIR=/mutations`.
- The LiveSync Deployment switches from the old mirror loop to the controller image.
- `mirror -> sync -> mirror` is no longer the daily sync path.

## Verification

Local checks:

```text
npm run lint
npm run typecheck
npm test
kubectl kustomize deploy/default
kubectl kustomize deploy/personal-full-access
```

Deployment checks:

- MCP rollout completed.
- LiveSync controller rollout completed.
- Temporary MCP smoke test completed:
  - `vault_write`
  - `vault_move`
  - `vault_delete`
- Mutations moved from `ready` to `done`.
- `/mutations/failed`, `/mutations/ready`, and `/mutations/processing` were empty after verification.
- Smoke-test source and destination paths were absent after delete.

## Operational Notes

- Do not restore the old `mirror -> sync -> mirror` daily loop.
- Do not add an independent sidecar that calls `livesync-cli rm/push/sync` while daemon is active.
- Keep `mirror` for explicit initialization or maintenance windows only.
- If `/mutations/failed` contains files, inspect the JSON `error` before deleting or retrying anything.
- If `processing` remains stuck, inspect controller logs before manual handling.
- Rollbacks should account for both MCP and the LiveSync controller. Rolling back only one side can reintroduce "filesystem change without DB mutation" states.

## Conclusion

The durable fix is to upgrade delete/move from plain filesystem events into auditable, replayable, replicable mutations:

```text
MCP emits intent
WAL preserves evidence
LiveSync controller serially writes DB state
CouchDB replicates deleted revisions
```

This prevents LiveSync from treating old paths as database-only active files that should be restored, addressing the source-path resurrection issue at its root.
