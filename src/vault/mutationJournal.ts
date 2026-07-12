import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteFile } from "./atomicWrite.js";
import { ToolDomainError } from "../mcp/errors.js";

export type MutationState = "pending" | "ready" | "processing" | "done" | "failed" | "cancelled";
export type MutationOperation = "delete" | "move";

export type MutationRecord = {
  schemaVersion: 1 | 2;
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
  localCommittedAt?: string;
  remoteVerifiedAt?: string;
  remoteVerification?: Record<string, unknown>;
  error?: string | { code: string; message: string; retryable: boolean };
  recoveryReason?: string;
  attempt: number;
};

export type OperationStatus = {
  ok: true;
  executionMode: "wal";
  operationId: string;
  operation: MutationOperation;
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  outcome?: "applied";
  commitLevel: "none" | "local" | "remote" | "unknown";
  stateUncertain?: true;
  path?: string;
  oldPath?: string;
  newPath?: string;
  trashPath?: string;
  createdAt: string;
  updatedAt: string;
  localCommittedAt?: string;
  remoteVerifiedAt?: string;
  remoteVerification?: Record<string, unknown>;
  attempt: number;
  error?: { code: string; message: string; retryable: boolean };
};

export class PendingMutation {
  constructor(
    private readonly journal: MutationJournal,
    readonly record: MutationRecord
  ) {}

  get id(): string {
    return this.record.id;
  }

  async markReady(patch: Partial<Pick<MutationRecord, "trashPath">> = {}): Promise<MutationRecord> {
    return this.journal.markReady(this.record, patch);
  }

  async cancel(message: string): Promise<MutationRecord> {
    return this.journal.cancel(this.record, message);
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
    return this.createPending({ op: "delete", path: notePath });
  }

  async createMove(oldPath: string, newPath: string, allowOverwrite: boolean): Promise<PendingMutation> {
    return this.createPending({ op: "move", oldPath, newPath, allowOverwrite });
  }

  async markReady(record: MutationRecord, patch: Partial<Pick<MutationRecord, "trashPath">> = {}): Promise<MutationRecord> {
    const pendingPath = this.filePath("pending", record.id);
    const readyPath = this.filePath("ready", record.id);
    const now = new Date().toISOString();
    const updated: MutationRecord = {
      ...record,
      ...patch,
      schemaVersion: 2,
      state: "ready",
      localCommittedAt: now,
      updatedAt: now
    };
    await atomicWriteFile(pendingPath, `${JSON.stringify(updated, null, 2)}\n`);
    await rename(pendingPath, readyPath);
    await fsyncDir(path.dirname(pendingPath));
    await fsyncDir(path.dirname(readyPath));
    return updated;
  }

  async cancel(record: MutationRecord, message: string): Promise<MutationRecord> {
    const pendingPath = this.filePath("pending", record.id);
    const cancelledPath = this.filePath("cancelled", record.id);
    const updated: MutationRecord = {
      ...record,
      schemaVersion: 2,
      state: "cancelled",
      error: { code: "INTERNAL_ERROR", message, retryable: false },
      updatedAt: new Date().toISOString()
    };
    await atomicWriteFile(pendingPath, `${JSON.stringify(updated, null, 2)}\n`);
    await rename(pendingPath, cancelledPath);
    await fsyncDir(path.dirname(pendingPath));
    await fsyncDir(path.dirname(cancelledPath));
    return updated;
  }

  async getOperation(operationId: string): Promise<OperationStatus> {
    validateMutationId(operationId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await this.findRecord(operationId);
      if (record) return operationStatus(record);
      if (attempt < 2) await sleep(50);
    }
    throw new ToolDomainError("PATH_NOT_FOUND", `operation not found: ${operationId}`, {
      details: {
        operationId,
        note: "The operation may never have existed, may have exceeded the retention period, or its WAL record may be unavailable."
      }
    });
  }

  private async findRecord(operationId: string): Promise<MutationRecord | undefined> {
    for (const state of ["pending", "ready", "processing", "failed", "cancelled"] as const) {
      const record = await readRecordIfExists(this.filePath(state, operationId));
      if (record) return record;
    }

    const doneRoot = path.join(this.root, "done");
    const dateDirs = await readdir(doneRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of dateDirs.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const record = await readRecordIfExists(path.join(doneRoot, entry.name, `${operationId}.json`));
      if (record) return record;
    }
    return undefined;
  }

  private async createPending(input: Pick<MutationRecord, "op"> & Partial<MutationRecord>): Promise<PendingMutation> {
    await this.init();
    const now = new Date().toISOString();
    const record: MutationRecord = {
      schemaVersion: 2,
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

  private filePath(state: Exclude<MutationState, "done">, id: string): string {
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

export function validateMutationId(value: string): string {
  if (!/^[0-9]{8}T[0-9]{9}Z-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new ToolDomainError("INVALID_ARGUMENT", "operationId has an invalid format", {
      details: { operationId: value }
    });
  }
  return value;
}

function operationStatus(record: MutationRecord): OperationStatus {
  const status = record.state === "done"
    ? "succeeded"
    : record.state === "pending" || record.state === "ready"
      ? "queued"
      : record.state;
  const commitLevel = record.remoteVerifiedAt
    ? "remote"
    : record.localCommittedAt
      ? "local"
      : record.state === "cancelled"
        ? "none"
        : "unknown";
  const result: OperationStatus = {
    ok: true,
    executionMode: "wal",
    operationId: record.id,
    operation: record.op,
    status,
    commitLevel,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    attempt: Number(record.attempt || 0)
  };
  if (commitLevel === "local" || commitLevel === "remote") result.outcome = "applied";
  if (commitLevel === "unknown") result.stateUncertain = true;
  if (record.path !== undefined) result.path = record.path;
  if (record.oldPath !== undefined) result.oldPath = record.oldPath;
  if (record.newPath !== undefined) result.newPath = record.newPath;
  if (record.trashPath !== undefined) result.trashPath = record.trashPath;
  if (record.localCommittedAt !== undefined) result.localCommittedAt = record.localCommittedAt;
  if (record.remoteVerifiedAt !== undefined) result.remoteVerifiedAt = record.remoteVerifiedAt;
  if (record.remoteVerification !== undefined) result.remoteVerification = record.remoteVerification;
  if (record.error !== undefined) result.error = normalizeRecordError(record.error);
  return result;
}

function normalizeRecordError(error: MutationRecord["error"]): { code: string; message: string; retryable: boolean } {
  if (typeof error === "string") return { code: "INTERNAL_ERROR", message: error, retryable: false };
  return error ?? { code: "INTERNAL_ERROR", message: "Unknown mutation failure", retryable: false };
}

async function readRecordIfExists(file: string): Promise<MutationRecord | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as MutationRecord;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
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

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
