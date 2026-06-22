import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

await testDeleteMutation();
await testMoveMutation();
await testMoveThenDeleteMutation();
await testProcessingRecovery();
console.log("livesync-controller ok");

async function testDeleteMutation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await writeMutation(fixture.mutations, "ready", {
      schemaVersion: 1,
      id: "delete-1",
      source: "obsidian-vault-mcp",
      op: "delete",
      state: "ready",
      path: "Notes/delete.md",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0
    });
    const controller = startController(fixture);
    await waitForDone(fixture, "delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.deepEqual(commands.map((command) => command.command).slice(0, 3), ["rm", "sync", "info"]);
    assert.equal(commands.at(0)?.args.at(-1), "Notes/delete.md");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function testMoveMutation(): Promise<void> {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.vault, "Notes"), { recursive: true });
    await writeFile(path.join(fixture.vault, "Notes", "new.md"), "new\n", "utf8");
    await writeMutation(fixture.mutations, "ready", {
      schemaVersion: 1,
      id: "move-1",
      source: "obsidian-vault-mcp",
      op: "move",
      state: "ready",
      oldPath: "Notes/old.md",
      newPath: "Notes/new.md",
      allowOverwrite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0
    });
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
    await writeMutation(fixture.mutations, "ready", {
      schemaVersion: 1,
      id: "move-delete-1",
      source: "obsidian-vault-mcp",
      op: "move",
      state: "ready",
      oldPath: "Notes/old.md",
      newPath: "Notes/missing-after-delete.md",
      allowOverwrite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0
    });
    await writeMutation(fixture.mutations, "ready", {
      schemaVersion: 1,
      id: "move-delete-2",
      source: "obsidian-vault-mcp",
      op: "delete",
      state: "ready",
      path: "Notes/missing-after-delete.md",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0
    });
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
    await writeMutation(fixture.mutations, "processing", {
      schemaVersion: 1,
      id: "processing-delete-1",
      source: "obsidian-vault-mcp",
      op: "delete",
      state: "processing",
      path: "Notes/stuck.md",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 1
    });
    const processingPath = path.join(fixture.mutations, "processing", "processing-delete-1.json");
    const old = new Date(Date.now() - 60_000);
    await utimes(processingPath, old, old);
    const controller = startController(fixture, { CONTROLLER_PROCESSING_TIMEOUT_MS: "1" });
    await waitForDone(fixture, "processing-delete-1", controller);
    controller.kill("SIGTERM");
    const commands = await readCommands(fixture.log);
    assert.equal(commands.at(0)?.command, "rm");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function createFixture(): Promise<{ root: string; vault: string; mutations: string; bin: string; log: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-livesync-controller-"));
  const vault = path.join(root, "vault");
  const mutations = path.join(root, "mutations");
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  await mkdir(vault, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const state of ["pending", "ready", "processing", "done", "failed", "cancelled"]) {
    await mkdir(path.join(mutations, state), { recursive: true });
  }
  const fakeCli = path.join(bin, "livesync-cli");
  await writeFile(fakeCli, fakeCliScript(log), "utf8");
  await chmod(fakeCli, 0o755);
  return { root, vault, mutations, bin, log };
}

function startController(fixture: { root: string; vault: string; mutations: string; bin: string }, env: Record<string, string> = {}) {
  const controller = spawn(process.execPath, ["livesync-controller/controller.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH || ""}`,
      LIVESYNC_DB_PATH: path.join(fixture.root, "data"),
      LIVESYNC_SETTINGS: path.join(fixture.root, "data", ".livesync", "settings.json"),
      LIVESYNC_VAULT: fixture.vault,
      MUTATION_QUEUE_DIR: fixture.mutations,
      CONTROLLER_POLL_INTERVAL_MS: "50",
      CONTROLLER_SHUTDOWN_TIMEOUT_MS: "1000",
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

async function waitForDone(fixture: { mutations: string; log: string }, id: string, controller?: ReturnType<typeof startController>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const output = controller?.output();
  throw new Error(`mutation did not finish: ${id}\nstdout:\n${output?.stdout || ""}\nstderr:\n${output?.stderr || ""}\nmutations:\n${await describeMutations(fixture.mutations)}\nfailed:\n${await readFailed(fixture.mutations)}\ncommands:\n${await readFile(fixture.log, "utf8").catch(() => "")}`);
}

async function readCommands(log: string): Promise<Array<{ command: string; args: string[] }>> {
  const content = await readFile(log, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function fakeCliScript(log: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const commands = new Set(["daemon", "rm", "push", "sync", "info"]);
const command = args.find((arg) => commands.has(arg));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + "\\n");
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
