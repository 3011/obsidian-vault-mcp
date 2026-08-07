import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer, rpc } from "./helpers.js";
import { ToolDomainError } from "../src/mcp/errors.js";
import { FsVault } from "../src/vault/FsVault.js";
import { MutationJournal, type MutationRecord } from "../src/vault/mutationJournal.js";

await assertDefaultDirectoryValidation();
await assertSynchronousResultsWithoutWal();

class FailingMutationJournal extends MutationJournal {
  override async createDelete(): Promise<any> {
    throw new Error("forced mutation failure");
  }

  override async createMove(): Promise<any> {
    throw new Error("forced mutation failure");
  }
}

class MarkReadyFailingJournal extends MutationJournal {
  override async markReady(): Promise<MutationRecord> {
    throw new Error("forced markReady failure");
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-mutations-"));
const vault = path.join(root, "vault");
const mutations = path.join(root, "mutations");
await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
const walServer = await createVaultServer({
  VAULT_ROOT: vault,
  MUTATION_QUEUE_DIR: mutations,
  TRASH_DELETE: "false",
  BACKUP_BEFORE_WRITE: "false"
});

try {
  const deleteWrite = await callTool(walServer.port, "vault_write", { path: "98-Inbox/delete-me.md", content: "delete\n" });
  assert.equal(deleteWrite.path, "98-Inbox/delete-me.md");
  const deleteResult = await callTool(walServer.port, "vault_delete", { path: "98-Inbox/delete-me.md" });
  assert.equal(deleteResult.executionMode, "wal");
  assert.equal(deleteResult.status, "queued");
  assert.equal(deleteResult.commitLevel, "local");
  assert.equal(typeof deleteResult.operationId, "string");
  const deleteRecord = await readStateMutation(mutations, "ready", deleteResult.operationId);
  assert.equal(deleteRecord.schemaVersion, 2);
  assert.equal(deleteRecord.op, "delete");
  assert.equal(deleteRecord.state, "ready");
  assert.equal(deleteRecord.path, "98-Inbox/delete-me.md");
  assert.equal(typeof deleteRecord.localCommittedAt, "string");

  const queriedDelete = await callTool(walServer.port, "vault_get_operation", { operationId: deleteResult.operationId });
  assert.equal(queriedDelete.ok, true);
  assert.equal(queriedDelete.status, "queued");
  assert.equal(queriedDelete.commitLevel, "local");
  assert.equal(queriedDelete.operationId, deleteResult.operationId);

  await callTool(walServer.port, "vault_write", { path: "98-Inbox/move-me.md", content: "move\n" });
  const moveResult = await callTool(walServer.port, "vault_move", { path: "98-Inbox/move-me.md", destination: "98-Inbox/moved.md" });
  assert.equal(moveResult.executionMode, "wal");
  assert.equal(typeof moveResult.operationId, "string");
  const moveRecord = await readStateMutation(mutations, "ready", moveResult.operationId);
  assert.equal(moveRecord.schemaVersion, 2);
  assert.equal(moveRecord.oldPath, "98-Inbox/move-me.md");
  assert.equal(moveRecord.newPath, "98-Inbox/moved.md");
  assert.equal(moveRecord.allowOverwrite, false);
  assert.equal(typeof moveRecord.localCommittedAt, "string");
  await stat(path.join(vault, "98-Inbox", "moved.md"));

  await mkdir(path.join(vault, "98-Inbox", "empty-dir"));
  const emptyDelete = await callTool(walServer.port, "vault_delete", { path: "98-Inbox/empty-dir" });
  assert.equal(emptyDelete.executionMode, "synchronous");
  assert.equal(emptyDelete.status, "succeeded");
  assert.equal("operationId" in emptyDelete, false);

  await assertStateTransitionRetry(walServer.port, mutations);
  await assertCrossDateDoneLookup(walServer.port, mutations);
  await assertConservativeV1Mappings(walServer.port, mutations);
  await assertInvalidOperationId(walServer.port);

  await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
  await writeFile(path.join(vault, "98-Inbox", "assets", "delete.png"), "asset\n", "utf8");
  const assetDelete = await callTool(walServer.port, "vault_delete", { path: "98-Inbox/assets/delete.png" });
  assert.equal(typeof assetDelete.operationId, "string");
  const assetDeleteRecord = await readStateMutation(mutations, "ready", assetDelete.operationId);
  assert.equal(assetDeleteRecord.path, "98-Inbox/assets/delete.png");

  await writeFile(path.join(vault, "98-Inbox", "assets", "move.png"), "asset\n", "utf8");
  const assetMove = await callTool(walServer.port, "vault_move", { path: "98-Inbox/assets/move.png", destination: "98-Inbox/assets/moved.png" });
  assert.equal(typeof assetMove.operationId, "string");
  const assetMoveRecord = await readStateMutation(mutations, "ready", assetMove.operationId);
  assert.equal(assetMoveRecord.newPath, "98-Inbox/assets/moved.png");

  await assertWalFailureDoesNotDelete(root);
  await assertWalFailureDoesNotMove(root);
  await assertWalCreatedErrorCarriesOperationId(root);

  console.log("mutations ok");
} finally {
  await walServer.close();
  await rm(root, { recursive: true, force: true });
}

async function assertSynchronousResultsWithoutWal(): Promise<void> {
  const server = await createVaultServer({ MUTATION_QUEUE_DIR: "", BACKUP_BEFORE_WRITE: "false" });
  try {
    await callTool(server.port, "vault_write", { path: "98-Inbox/local-move.md", content: "local\n" });
    const move = await callTool(server.port, "vault_move", {
      path: "98-Inbox/local-move.md",
      destination: "98-Inbox/local-moved.md"
    });
    assert.equal(move.executionMode, "synchronous");
    assert.equal(move.status, "succeeded");
    assert.equal(move.commitLevel, "local");
    assert.equal("operationId" in move, false);

    await mkdir(path.join(server.vault, "98-Inbox", "local-empty"));
    const deleted = await callTool(server.port, "vault_delete", { path: "98-Inbox/local-empty" });
    assert.equal(deleted.executionMode, "synchronous");
    assert.equal("operationId" in deleted, false);
  } finally {
    await server.close();
  }
}

async function assertStateTransitionRetry(port: number, root: string): Promise<void> {
  const id = validId("11111111-1111-4111-8111-111111111111");
  const now = new Date().toISOString();
  const record: MutationRecord = {
    schemaVersion: 2,
    id,
    source: "obsidian-vault-mcp",
    op: "delete",
    state: "ready",
    path: "Notes/gap.md",
    createdAt: now,
    updatedAt: now,
    localCommittedAt: now,
    attempt: 0
  };
  await writeStateMutation(root, "ready", record);
  const gapPath = path.join(root, `${id}.moving`);
  await rename(path.join(root, "ready", `${id}.json`), gapPath);
  const restore = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      rename(gapPath, path.join(root, "processing", `${id}.json`)).then(resolve, reject);
    }, 75);
  });
  const queried = await callTool(port, "vault_get_operation", { operationId: id });
  await restore;
  assert.equal(queried.operationId, id);
  assert.equal(queried.commitLevel, "local");
}

async function assertCrossDateDoneLookup(port: number, root: string): Promise<void> {
  const id = "20200101T000000000Z-22222222-2222-4222-8222-222222222222";
  const createdAt = "2020-01-01T00:00:00.000Z";
  const verifiedAt = "2026-07-13T00:00:01.000Z";
  const record: MutationRecord = {
    schemaVersion: 2,
    id,
    source: "obsidian-vault-mcp",
    op: "move",
    state: "done",
    oldPath: "Notes/old.md",
    newPath: "Notes/new.md",
    createdAt,
    updatedAt: verifiedAt,
    localCommittedAt: "2026-07-12T23:59:59.000Z",
    remoteVerifiedAt: verifiedAt,
    remoteVerification: { method: "livesync-cli-post-sync-info" },
    attempt: 1
  };
  const doneDir = path.join(root, "done", "2026-07-13");
  await mkdir(doneDir, { recursive: true });
  await writeFile(path.join(doneDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const queried = await callTool(port, "vault_get_operation", { operationId: id });
  assert.equal(queried.status, "succeeded");
  assert.equal(queried.commitLevel, "remote");
  assert.equal(queried.remoteVerifiedAt, verifiedAt);
}

async function assertConservativeV1Mappings(port: number, root: string): Promise<void> {
  const pendingId = validId("33333333-3333-4333-8333-333333333333");
  const cancelledId = validId("44444444-4444-4444-8444-444444444444");
  const now = new Date().toISOString();
  await writeStateMutation(root, "pending", {
    schemaVersion: 1,
    id: pendingId,
    source: "obsidian-vault-mcp",
    op: "delete",
    state: "pending",
    path: "Notes/legacy.md",
    createdAt: now,
    updatedAt: now,
    attempt: 0
  });
  await writeStateMutation(root, "cancelled", {
    schemaVersion: 1,
    id: cancelledId,
    source: "obsidian-vault-mcp",
    op: "delete",
    state: "cancelled",
    path: "Notes/cancelled.md",
    createdAt: now,
    updatedAt: now,
    attempt: 0
  });
  const pending = await callTool(port, "vault_get_operation", { operationId: pendingId });
  assert.equal(pending.commitLevel, "unknown");
  assert.equal(pending.stateUncertain, true);
  const cancelled = await callTool(port, "vault_get_operation", { operationId: cancelledId });
  assert.equal(cancelled.commitLevel, "none");
  assert.equal(cancelled.status, "cancelled");
}

async function assertInvalidOperationId(port: number): Promise<void> {
  const response = await rpc(port, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "vault_get_operation", arguments: { operationId: "../ready/anything" } }
  });
  assert.equal(response.error?.code, -32602, JSON.stringify(response));
}

async function assertDefaultDirectoryValidation(): Promise<void> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-default-dir-"));
  try {
    const missingInbox = new FsVault(path.join(parent, "missing-inbox"), "98-Inbox", {
      validateDefaultWriteDir: true,
      backupBeforeWrite: false
    });
    await assert.rejects(() => missingInbox.init(), /default write directory not found: 98-Inbox/i);

  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertWalFailureDoesNotDelete(parent: string): Promise<void> {
  const localVault = path.join(parent, "failing-delete-vault");
  await mkdir(path.join(localVault, "Notes"), { recursive: true });
  await writeFile(path.join(localVault, "Notes", "keep.md"), "keep\n", "utf8");
  const vault = new FsVault(localVault, "Notes", {
    trashDelete: false,
    backupBeforeWrite: false,
    mutationJournal: new FailingMutationJournal(path.join(parent, "failing-delete-mutations"))
  });
  await vault.init();
  await assert.rejects(() => vault.delete("Notes/keep.md"), /forced mutation failure/);
  assert.equal(await readFile(path.join(localVault, "Notes", "keep.md"), "utf8"), "keep\n");
}

async function assertWalFailureDoesNotMove(parent: string): Promise<void> {
  const localVault = path.join(parent, "failing-move-vault");
  await mkdir(path.join(localVault, "Notes"), { recursive: true });
  await writeFile(path.join(localVault, "Notes", "source.md"), "source\n", "utf8");
  const vault = new FsVault(localVault, "Notes", {
    trashDelete: false,
    backupBeforeWrite: false,
    mutationJournal: new FailingMutationJournal(path.join(parent, "failing-move-mutations"))
  });
  await vault.init();
  await assert.rejects(() => vault.move("Notes/source.md", "Notes/dest.md"), /forced mutation failure/);
  assert.equal(await readFile(path.join(localVault, "Notes", "source.md"), "utf8"), "source\n");
  await assert.rejects(() => stat(path.join(localVault, "Notes", "dest.md")), /ENOENT/);
}

async function assertWalCreatedErrorCarriesOperationId(parent: string): Promise<void> {
  const localVault = path.join(parent, "mark-ready-failure-vault");
  const journalRoot = path.join(parent, "mark-ready-failure-mutations");
  await mkdir(path.join(localVault, "Notes"), { recursive: true });
  await writeFile(path.join(localVault, "Notes", "source.md"), "source\n", "utf8");
  const journal = new MarkReadyFailingJournal(journalRoot);
  const vault = new FsVault(localVault, "Notes", {
    backupBeforeWrite: false,
    mutationJournal: journal
  });
  await vault.init();
  let caught: unknown;
  try {
    await vault.move("Notes/source.md", "Notes/dest.md");
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof ToolDomainError);
  assert.equal(caught.result?.commitLevel, "unknown");
  assert.equal(caught.result?.stateUncertain, true);
  assert.equal(typeof caught.result?.operationId, "string");
  const operationId = caught.result?.operationId as string;
  const queried = await journal.getOperation(operationId);
  assert.equal(queried.operationId, operationId);
  assert.equal(queried.commitLevel, "unknown");
  assert.equal(await readFile(path.join(localVault, "Notes", "dest.md"), "utf8"), "source\n");
}

async function readStateMutation(root: string, state: string, id: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root, state, `${id}.json`), "utf8"));
}

async function writeStateMutation(root: string, state: string, record: MutationRecord): Promise<void> {
  await writeFile(path.join(root, state, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function validId(uuid: string): string {
  return `20260712T170000000Z-${uuid}`;
}
