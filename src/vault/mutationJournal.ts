import { mkdir, open, rename } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";

export type MutationState = "pending" | "ready" | "processing" | "done" | "failed" | "cancelled";
export type MutationOperation = "delete" | "move";

export type MutationRecord = {
  schemaVersion: 1;
  id: string;
  source: "obsidian-vault-mcp";
  op: MutationOperation;
  state: MutationState;
  path?: string;
  oldPath?: string;
  newPath?: string;
  trashPath?: string;
  allowOverwrite?: boolean;
  createdAt: string;
  updatedAt: string;
  attempt: number;
};

export class PendingMutation {
  constructor(
    private readonly journal: MutationJournal,
    readonly record: MutationRecord
  ) {}

  async markReady(patch: Partial<Pick<MutationRecord, "trashPath">> = {}): Promise<MutationRecord> {
    return this.journal.markReady(this.record, patch);
  }
}

export class MutationJournal {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    for (const dir of ["pending", "ready", "processing", "done", "failed", "cancelled"]) {
      await mkdir(path.join(this.root, dir), { recursive: true });
    }
    await fsyncDir(this.root);
  }

  async createDelete(notePath: string): Promise<PendingMutation> {
    return this.createPending({
      op: "delete",
      path: notePath
    });
  }

  async createMove(oldPath: string, newPath: string, allowOverwrite: boolean): Promise<PendingMutation> {
    return this.createPending({
      op: "move",
      oldPath,
      newPath,
      allowOverwrite
    });
  }

  async markReady(record: MutationRecord, patch: Partial<Pick<MutationRecord, "trashPath">> = {}): Promise<MutationRecord> {
    const pendingPath = this.filePath("pending", record.id);
    const readyPath = this.filePath("ready", record.id);
    const updated: MutationRecord = {
      ...record,
      ...patch,
      state: "ready",
      updatedAt: new Date().toISOString()
    };
    await atomicWriteFile(pendingPath, `${JSON.stringify(updated, null, 2)}\n`);
    await rename(pendingPath, readyPath);
    await fsyncDir(path.dirname(pendingPath));
    await fsyncDir(path.dirname(readyPath));
    return updated;
  }

  private async createPending(input: Pick<MutationRecord, "op"> & Partial<MutationRecord>): Promise<PendingMutation> {
    await this.init();
    const now = new Date().toISOString();
    const record: MutationRecord = {
      schemaVersion: 1,
      id: createMutationId(),
      source: "obsidian-vault-mcp",
      op: input.op,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      attempt: 0
    };
    if (input.path !== undefined) record.path = input.path;
    if (input.oldPath !== undefined) record.oldPath = input.oldPath;
    if (input.newPath !== undefined) record.newPath = input.newPath;
    if (input.allowOverwrite !== undefined) record.allowOverwrite = input.allowOverwrite;

    const file = this.filePath("pending", record.id);
    await atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
    await fsyncDir(path.dirname(file));
    return new PendingMutation(this, record);
  }

  private filePath(state: Exclude<MutationState, "done"> | "done", id: string): string {
    return path.join(this.root, state, `${id}.json`);
  }
}

export function validateMutationQueueDir(rawDir: string, vaultRoot: string): string {
  if (!path.isAbsolute(rawDir)) throw new Error("MUTATION_QUEUE_DIR must be an absolute path");
  const root = path.resolve(rawDir);
  const vault = path.resolve(vaultRoot);
  const relative = path.relative(vault, root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("MUTATION_QUEUE_DIR must not be inside VAULT_ROOT");
  }
  return root;
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function createMutationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${crypto.randomUUID()}`;
}
