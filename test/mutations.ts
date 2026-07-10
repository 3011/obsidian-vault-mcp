import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { callTool, createVaultServer } from "./helpers.js";
import { FsVault } from "../src/vault/FsVault.js";
import { MutationJournal } from "../src/vault/mutationJournal.js";

await assertDefaultDirectoryValidation();

class FailingMutationJournal extends MutationJournal {
  override async createDelete(): Promise<any> {
    throw new Error("forced mutation failure");
  }

  override async createMove(): Promise<any> {
    throw new Error("forced mutation failure");
  }
}

const server = await createVaultServer({
  MUTATION_QUEUE_DIR: ""
});
await server.close();

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
  await callTool(walServer.port, "vault_write", { path: "98-Inbox/delete-me.md", content: "delete\n" });
  await callTool(walServer.port, "vault_delete", { path: "98-Inbox/delete-me.md" });
  const deleteRecord = await firstReadyMutation(mutations);
  assert.equal(deleteRecord.op, "delete");
  assert.equal(deleteRecord.state, "ready");
  assert.equal(deleteRecord.path, "98-Inbox/delete-me.md");

  await callTool(walServer.port, "vault_write", { path: "98-Inbox/move-me.md", content: "move\n" });
  await callTool(walServer.port, "vault_move", { path: "98-Inbox/move-me.md", destination: "98-Inbox/moved.md" });
  const records = await readyMutations(mutations);
  const moveRecord = records.find((record: any) => record.op === "move");
  assert(moveRecord);
  assert.equal(moveRecord.oldPath, "98-Inbox/move-me.md");
  assert.equal(moveRecord.newPath, "98-Inbox/moved.md");
  assert.equal(moveRecord.allowOverwrite, false);
  await stat(path.join(vault, "98-Inbox", "moved.md"));

  await mkdir(path.join(vault, "98-Inbox", "assets"), { recursive: true });
  await writeFile(path.join(vault, "98-Inbox", "assets", "delete.png"), "asset\n", "utf8");
  await callTool(walServer.port, "vault_delete", { path: "98-Inbox/assets/delete.png" });
  const assetDeleteRecord = (await readyMutations(mutations)).find((record: any) => record.op === "delete" && record.path === "98-Inbox/assets/delete.png");
  assert(assetDeleteRecord);
  await writeFile(path.join(vault, "98-Inbox", "assets", "move.png"), "asset\n", "utf8");
  await callTool(walServer.port, "vault_move", { path: "98-Inbox/assets/move.png", destination: "98-Inbox/assets/moved.png" });
  const assetMoveRecord = (await readyMutations(mutations)).find((record: any) => record.op === "move" && record.oldPath === "98-Inbox/assets/move.png");
  assert(assetMoveRecord);
  assert.equal(assetMoveRecord.newPath, "98-Inbox/assets/moved.png");

  await assertWalFailureDoesNotDelete(root);
  await assertWalFailureDoesNotMove(root);

  console.log("mutations ok");
} finally {
  await walServer.close();
  await rm(root, { recursive: true, force: true });
}

async function assertDefaultDirectoryValidation(): Promise<void> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "obsidian-vault-mcp-default-dir-"));
  try {
    const missingInbox = new FsVault(path.join(parent, "missing-inbox"), "98-Inbox", {
      validateDefaultWriteDir: true,
      backupBeforeWrite: false
    });
    await assert.rejects(() => missingInbox.init(), /default write directory not found: 98-Inbox/i);

    const missingAssetsRoot = path.join(parent, "missing-assets");
    await mkdir(path.join(missingAssetsRoot, "98-Inbox"), { recursive: true });
    const missingAssets = new FsVault(missingAssetsRoot, "98-Inbox", {
      validateDefaultWriteDir: true,
      validateDefaultAssetDir: true,
      backupBeforeWrite: false
    });
    await assert.rejects(() => missingAssets.init(), /default asset directory not found: 98-Inbox\/assets/i);
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

async function firstReadyMutation(root: string): Promise<any> {
  const records = await readyMutations(root);
  assert(records.length > 0);
  return records[0];
}

async function readyMutations(root: string): Promise<any[]> {
  const dir = path.join(root, "ready");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8"))));
}
