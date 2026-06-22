#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const config = {
  cli: process.env.LIVESYNC_CLI_BIN || "livesync-cli",
  dbPath: process.env.LIVESYNC_DB_PATH || "/data",
  settings: process.env.LIVESYNC_SETTINGS || "/data/.livesync/settings.json",
  vault: process.env.LIVESYNC_VAULT || "/vault",
  mutations: process.env.MUTATION_QUEUE_DIR || "/mutations",
  pollIntervalMs: positiveInt(process.env.CONTROLLER_POLL_INTERVAL_MS, 5000),
  processingTimeoutMs: positiveInt(process.env.CONTROLLER_PROCESSING_TIMEOUT_MS, 10 * 60 * 1000),
  shutdownTimeoutMs: positiveInt(process.env.CONTROLLER_SHUTDOWN_TIMEOUT_MS, 30 * 1000),
  daemonArgs: splitArgs(process.env.LIVESYNC_DAEMON_ARGS || "")
};

let daemon = null;
let stopping = false;

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await ensureLayout();
await recoverProcessing();

while (!stopping) {
  await processReadyBatch();
  if (stopping) break;
  await runDaemonUntilMutationOrExit();
}

async function runDaemonUntilMutationOrExit() {
  daemon = spawn(config.cli, livesyncArgs("daemon", ...config.daemonArgs), { stdio: "inherit" });
  const exitPromise = new Promise((resolve) => {
    daemon.once("exit", (code, signal) => resolve({ code, signal }));
  });

  while (!stopping) {
    const exited = await Promise.race([
      exitPromise.then((result) => ({ type: "exit", result })),
      sleep(config.pollIntervalMs).then(() => ({ type: "tick" }))
    ]);
    if (exited.type === "exit") {
      daemon = null;
      console.log(JSON.stringify({ level: "warn", message: "livesync daemon exited", ...exited.result }));
      await sleep(config.pollIntervalMs);
      return;
    }
    if ((await listStateFiles("ready")).length > 0) {
      await stopDaemon();
      return;
    }
  }

  await stopDaemon();
}

async function processReadyBatch() {
  while (!stopping) {
    const files = await listStateFiles("ready");
    if (files.length === 0) return;
    for (const file of files) {
      if (stopping) return;
      await processMutation(file);
    }
  }
}

async function processMutation(file) {
  let record = await readMutation(file);
  const processingPath = statePath("processing", path.basename(file));
  await rename(file, processingPath);
  record = { ...record, state: "processing", attempt: Number(record.attempt || 0) + 1, updatedAt: new Date().toISOString() };
  await writeJson(processingPath, record);
  await fsyncDir(path.dirname(processingPath));

  try {
    if (record.op === "delete") await applyDelete(record);
    else if (record.op === "move") await applyMove(record);
    else throw new Error(`unsupported mutation op: ${record.op}`);

    const doneDir = path.join(config.mutations, "done", new Date().toISOString().slice(0, 10));
    await mkdir(doneDir, { recursive: true });
    const donePath = path.join(doneDir, path.basename(processingPath));
    await writeJson(processingPath, { ...record, state: "done", updatedAt: new Date().toISOString() });
    await rename(processingPath, donePath);
    await fsyncDir(path.dirname(processingPath));
    await fsyncDir(doneDir);
    console.log(JSON.stringify({ level: "info", message: "mutation done", id: record.id, op: record.op }));
  } catch (error) {
    await failMutation(processingPath, record, error);
  }
}

async function applyDelete(record) {
  const notePath = requiredString(record.path, "path");
  await runRmIdempotent(notePath);
  await runCli("sync");
  await assertNotActive(notePath);
}

async function applyMove(record) {
  const oldPath = requiredString(record.oldPath, "oldPath");
  const newPath = requiredString(record.newPath, "newPath");
  const newAbsolute = path.join(config.vault, newPath);
  const newExists = await exists(newAbsolute);
  await runRmIdempotent(oldPath);
  if (newExists) {
    await runCli("push", newAbsolute, newPath);
  } else {
    console.log(JSON.stringify({ level: "warn", message: "move destination missing; marking destination deleted", id: record.id, newPath }));
    await runRmIdempotent(newPath);
  }
  await runCli("sync");
  await assertNotActive(oldPath);
  if (newExists) await assertActive(newPath);
  else await assertNotActive(newPath);
}

async function recoverProcessing() {
  const files = await listStateFiles("processing");
  const now = Date.now();
  for (const file of files) {
    const fileStat = await stat(file);
    if (now - fileStat.mtimeMs < config.processingTimeoutMs) continue;
    const record = await readMutation(file);
    if (record.op === "move") {
      const newPath = typeof record.newPath === "string" ? path.join(config.vault, record.newPath) : "";
      if (!newPath || !(await exists(newPath))) {
        await failMutation(file, record, new Error("processing timeout and move newPath is missing"));
        continue;
      }
    }
    const readyPath = statePath("ready", path.basename(file));
    await writeJson(file, { ...record, state: "ready", updatedAt: new Date().toISOString() });
    await rename(file, readyPath);
    await fsyncDir(path.dirname(file));
    await fsyncDir(path.dirname(readyPath));
    console.log(JSON.stringify({ level: "warn", message: "recovered processing mutation", id: record.id }));
  }
}

async function assertNotActive(notePath) {
  const result = await runCliCapture("info", notePath);
  if (result.code !== 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/not found|file not found|deleted/i.test(output)) {
    throw new Error(`path still appears active after mutation: ${notePath}`);
  }
}

async function runRmIdempotent(notePath) {
  const result = await runCliCapture("rm", notePath);
  if (result.code === 0) return;
  await assertNotActive(notePath);
}

async function assertActive(notePath) {
  const result = await runCliCapture("info", notePath);
  if (result.code !== 0) throw new Error(`path is not active after mutation: ${notePath}`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not found|file not found|deleted/i.test(output)) {
    throw new Error(`path is not active after mutation: ${notePath}`);
  }
}

async function runCli(command, ...args) {
  const result = await runCliCapture(command, ...args);
  if (result.code !== 0) throw new Error(`livesync-cli ${command} failed with code ${result.code}`);
}

async function runCliCapture(command, ...args) {
  const child = spawn(config.cli, livesyncArgs(command, ...args), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

function livesyncArgs(command, ...args) {
  return [config.dbPath, "--settings", config.settings, "--vault", config.vault, command, ...args];
}

async function stopDaemon() {
  if (!daemon) return;
  const child = daemon;
  daemon = null;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(config.shutdownTimeoutMs).then(() => "timeout")
  ]);
  if (exited === "timeout") {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", message: "controller shutting down", signal }));
  await stopDaemon();
}

async function failMutation(processingPath, record, error) {
  const failedPath = statePath("failed", path.basename(processingPath));
  const failed = {
    ...record,
    state: "failed",
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  };
  await writeJson(processingPath, failed);
  await rename(processingPath, failedPath);
  await fsyncDir(path.dirname(processingPath));
  await fsyncDir(path.dirname(failedPath));
  console.error(JSON.stringify({ level: "error", message: "mutation failed", id: record.id, op: record.op, error: failed.error }));
}

async function ensureLayout() {
  for (const dir of ["pending", "ready", "processing", "done", "failed", "cancelled"]) {
    await mkdir(path.join(config.mutations, dir), { recursive: true });
  }
  await fsyncDir(config.mutations);
}

async function listStateFiles(state) {
  const dir = path.join(config.mutations, state);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

async function readMutation(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const handle = await open(temp, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

async function fsyncDir(dir) {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function statePath(state, basename) {
  return path.join(config.mutations, state, basename);
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  if (value.includes("\0") || path.isAbsolute(value) || value.startsWith("../") || value.includes("/../")) {
    throw new Error(`${name} is not a safe relative path`);
  }
  return value;
}

function positiveInt(raw, fallback) {
  const value = Number.parseInt(raw || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function splitArgs(raw) {
  return raw.trim() ? raw.trim().split(/\s+/) : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
