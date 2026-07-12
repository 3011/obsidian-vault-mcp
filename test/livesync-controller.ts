import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

await testDeleteMutation();
await testMoveMutation();
await testMoveThenDeleteMutation();
await testProcessingRecovery();
await testPendingDeleteRecovery();
await testPendingMoveRecovery();
await testPendingMoveCancellation();
await testPendingMoveAmbiguousFailure();
await testCliLockRetry();
console.log("livesync-controller ok");

type Fixture = {
  root: string;
  vault: string;
  mutations: string;
  bin: string;
  log: string;
  state: string;
};

async function testDeleteMutation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "ready", mutation({ id: "delete-1", op: "delete", path: "Notes/delete.md" }));
    const controller = startController(fixture);
    await waitForDone(fixture, "delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 3), ["rm", "sync", "info"]);
    assert.equal(commands.at(0)?.args.at(-1), "Notes/delete.md");
    const done = await readDoneRecord(fixture, "delete-1");
    assert.equal(done.schemaVersion, 2);
    assert.equal(typeof done.remoteVerifiedAt, "string");
    assert.equal((done.remoteVerification as any)?.method, "livesync-cli-post-sync-info");
    assert.equal((done.remoteVerification as any)?.pathState, "not-active");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testMoveMutation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.vault, "Notes"), { recursive: true });
    await writeFile(path.join(fixture.vault, "Notes", "new.md"), "new\n", "utf8");
    await writeMutation(fixture.mutations, "ready", mutation({
      id: "move-1",
      op: "move",
      oldPath: "Notes/old.md",
      newPath: "Notes/new.md",
      allowOverwrite: false
    }));
    const controller = startController(fixture);
    await waitForDone(fixture, "move-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 5), ["rm", "push", "sync", "info", "info"]);
    assert.equal(commands.at(0)?.args.at(-1), "Notes/old.md");
    assert.equal(commands.at(1)?.args.at(-2), path.join(fixture.vault, "Notes", "new.md"));
    assert.equal(commands.at(1)?.args.at(-1), "Notes/new.md");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testMoveThenDeleteMutation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "ready", mutation({
      id: "move-delete-1",
      op: "move",
      oldPath: "Notes/old.md",
      newPath: "Notes/missing-after-delete.md",
      allowOverwrite: false
    }));
    await writeMutation(fixture.mutations, "ready", mutation({
      id: "move-delete-2",
      op: "delete",
      path: "Notes/missing-after-delete.md"
    }));
    const controller = startController(fixture);
    await waitForDone(fixture, "move-delete-1", controller);
    await waitForDone(fixture, "move-delete-2", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 8), ["rm", "rm", "sync", "info", "info", "rm", "sync", "info"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testProcessingRecovery(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "processing", mutation({
      id: "processing-delete-1",
      op: "delete",
      path: "Notes/stuck.md",
      state: "processing",
      attempt: 1
    }));
    await ageMutation(fixture.mutations, "processing", "processing-delete-1");
    const controller = startController(fixture, { CONTROLLER_PROCESSING_TIMEOUT_MS: "1" });
    await waitForDone(fixture, "processing-delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.equal(commands.at(0)?.command, "rm");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testPendingDeleteRecovery(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "pending", mutation({
      id: "pending-delete-1",
      op: "delete",
      path: "Notes/pending-delete.md",
      state: "pending"
    }));
    await ageMutation(fixture.mutations, "pending", "pending-delete-1");
    const controller = startController(fixture, { CONTROLLER_PENDING_TIMEOUT_MS: "1" });
    await waitForDone(fixture, "pending-delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.equal(commands.at(0)?.command, "rm");
    const done = await readDoneRecord(fixture, "pending-delete-1");
    assert.equal(typeof done.localCommittedAt, "string");
    assert.equal(typeof done.remoteVerifiedAt, "string");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testPendingMoveRecovery(): Promise<void> {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.vault, "Notes"), { recursive: true });
    await writeFile(path.join(fixture.vault, "Notes", "pending-new.md"), "new\n", "utf8");
    await writeMutation(fixture.mutations, "pending", mutation({
      id: "pending-move-1",
      op: "move",
      oldPath: "Notes/pending-old.md",
      newPath: "Notes/pending-new.md",
      state: "pending"
    }));
    await ageMutation(fixture.mutations, "pending", "pending-move-1");
    const controller = startController(fixture, { CONTROLLER_PENDING_TIMEOUT_MS: "1" });
    await waitForDone(fixture, "pending-move-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 2), ["rm", "push"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testPendingMoveCancellation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.vault, "Notes"), { recursive: true });
    await writeFile(path.join(fixture.vault, "Notes", "cancel-old.md"), "old\n", "utf8");
    await writeMutation(fixture.mutations, "pending", mutation({
      id: "pending-cancel-1",
      op: "move",
      oldPath: "Notes/cancel-old.md",
      newPath: "Notes/cancel-new.md",
      state: "pending"
    }));
    await ageMutation(fixture.mutations, "pending", "pending-cancel-1");
    const controller = startController(fixture, { CONTROLLER_PENDING_TIMEOUT_MS: "1" });
    await waitForState(fixture, "cancelled", "pending-cancel-1", controller);
    controller.kill("SIGTERM");
    const record = JSON.parse(await readFile(path.join(fixture.mutations, "cancelled", "pending-cancel-1.json"), "utf8")) as Record<string, unknown>;
    assert.match(String(record.recoveryReason), /did not complete/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testPendingMoveAmbiguousFailure(): Promise<void> {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.vault, "Notes"), { recursive: true });
    await writeFile(path.join(fixture.vault, "Notes", "ambiguous-old.md"), "old\n", "utf8");
    await writeFile(path.join(fixture.vault, "Notes", "ambiguous-new.md"), "new\n", "utf8");
    await writeMutation(fixture.mutations, "pending", mutation({
      id: "pending-ambiguous-1",
      op: "move",
      oldPath: "Notes/ambiguous-old.md",
      newPath: "Notes/ambiguous-new.md",
      state: "pending"
    }));
    await ageMutation(fixture.mutations, "pending", "pending-ambiguous-1");
    const controller = startController(fixture, { CONTROLLER_PENDING_TIMEOUT_MS: "1" });
    await waitForState(fixture, "failed", "pending-ambiguous-1", controller);
    controller.kill("SIGTERM");
    const record = JSON.parse(await readFile(path.join(fixture.mutations, "failed", "pending-ambiguous-1.json"), "utf8")) as Record<string, unknown>;
    assert.match(String(record.error), /ambiguous/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testCliLockRetry(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "ready", mutation({
      id: "retry-delete-1",
      op: "delete",
      path: "Notes/retry-delete.md"
    }));
    const controller = startController(fixture, {
      FAKE_CLI_FAIL_ONCE_COMMAND: "rm",
      CONTROLLER_CLI_MAX_ATTEMPTS: "3",
      CONTROLLER_CLI_RETRY_BASE_MS: "1",
      CONTROLLER_CLI_RETRY_MAX_MS: "2"
    });
    await waitForDone(fixture, "retry-delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 2), ["rm", "rm"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function mutation(input: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    source: "obsidian-vault-mcp",
    state: "ready",
    createdAt: now,
    updatedAt: now,
    attempt: 0,
    ...input
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-livesync-controller-"));
  const vault = path.join(root, "vault");
  const mutations = path.join(root, "mutations");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const state = path.join(root, "state");
  await mkdir(vault, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  for (const mutationState of ["pending", "ready", "processing", "done", "failed", "cancelled"]) {
    await mkdir(path.join(mutations, mutationState), { recursive: true });
  }
  const fakeCli = path.join(bin, "livesync-cli");
  await writeFile(fakeCli, fakeCliScript(log), "utf8");
  await chmod(fakeCli, 0o755);
  return { root, vault, mutations, bin, log, state };
}

function startController(fixture: Fixture, env: Record<string, string> = {}) {
  const controller = spawn(process.execPath, ["livesync-controller/controller.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH || ""}`,
      LIVESYNC_DB_PATH: path.join(fixture.root, "data"),
      LIVESYNC_SETTINGS: path.join(fixture.root, "data", ".livesync", "settings.json"),
      LIVESYNC_VAULT: fixture.vault,
      MUTATION_QUEUE_DIR: fixture.mutations,
      CONTROLLER_POLL_INTERVAL_MS: "25",
      CONTROLLER_PENDING_TIMEOUT_MS: "5000",
      CONTROLLER_PROCESSING_TIMEOUT_MS: "5000",
      CONTROLLER_SHUTDOWN_TIMEOUT_MS: "1000",
      CONTROLLER_CLI_RETRY_BASE_MS: "1",
      CONTROLLER_CLI_RETRY_MAX_MS: "2",
      FAKE_CLI_STATE_DIR: fixture.state,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  controller.stdout.on("data", (chunk) => { stdout += String(chunk); });
  controller.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return Object.assign(controller, {
    output: () => ({ stdout, stderr })
  });
}

async function writeMutation(root: string, state: string, record: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(root, state, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function ageMutation(root: string, state: string, id: string): Promise<void> {
  const file = path.join(root, state, `${id}.json`);
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
}

async function readDoneRecord(fixture: Fixture, id: string): Promise<Record<string, unknown>> {
  const doneRoot = path.join(fixture.mutations, "done");
  const dates = await readdir(doneRoot).catch(() => []);
  for (const date of dates) {
    const file = path.join(doneRoot, date, `${id}.json`);
    try {
      return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`done mutation not found: ${id}`);
}

async function waitForDone(fixture: Fixture, id: string, controller?: ReturnType<typeof startController>): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const doneRoot = path.join(fixture.mutations, "done");
    const dates = await readdir(doneRoot).catch(() => []);
    for (const date of dates) {
      try {
        await stat(path.join(doneRoot, date, `${id}.json`));
        return;
      } catch {
        // keep waiting
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(await failureDetails(fixture, id, controller));
}

async function waitForState(fixture: Fixture, state: string, id: string, controller?: ReturnType<typeof startController>): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    try {
      await stat(path.join(fixture.mutations, state, `${id}.json`));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(await failureDetails(fixture, id, controller));
}

async function failureDetails(fixture: Fixture, id: string, controller?: ReturnType<typeof startController>): Promise<string> {
  const output = controller?.output();
  return `mutation did not finish: ${id}\nstdout:\n${output?.stdout || ""}\nstderr:\n${output?.stderr || ""}\nmutations:\n${await describeMutations(fixture.mutations)}\nfailed:\n${await readFailed(fixture.mutations)}\ncommands:\n${await readFile(fixture.log, "utf8").catch(() => "")}`;
}

async function readCommands(log: string): Promise<Array<{ command: string; args: string[] }>> {
  const content = await readFile(log, "utf8").catch(() => "");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { command: string; args: string[] });
}

function fakeCliScript(log: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const commands = new Set(["daemon", "rm", "push", "sync", "info"]);
const command = args.find((arg) => commands.has(arg));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + "\\n");
const failOnce = process.env.FAKE_CLI_FAIL_ONCE_COMMAND;
if (failOnce && command === failOnce) {
  const marker = path.join(process.env.FAKE_CLI_STATE_DIR || ".", "failed-once-" + command);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "1");
    process.stderr.write("Could not initialise database: IO error: lock held by another process\\n");
    process.exit(1);
  }
}
if (command === "daemon") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (command === "info") {
  const note = args.at(-1) || "";
  if (note.includes("old") || note.includes("delete") || note.includes("stuck")) {
    process.stderr.write("File not found\\n");
    process.exit(1);
  }
  console.log("active");
} else {
  process.exit(0);
}
`;
}

async function describeMutations(root: string): Promise<string> {
  const lines: string[] = [];
  for (const state of ["pending", "ready", "processing", "done", "failed", "cancelled"]) {
    const dir = path.join(root, state);
    const entries = await readdir(dir).catch(() => []);
    lines.push(`${state}: ${entries.join(",")}`);
  }
  return lines.join("\n");
}

async function readFailed(root: string): Promise<string> {
  const dir = path.join(root, "failed");
  const files = await readdir(dir).catch(() => []);
  const contents = await Promise.all(files.map((file) => readFile(path.join(dir, file), "utf8")));
  return contents.join("\n");
}
