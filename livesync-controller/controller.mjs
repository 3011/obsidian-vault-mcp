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
  pendingTimeoutMs: positiveInt(process.env.CONTROLLER_PENDING_TIMEOUT_MS, 60_000),
  processingTimeoutMs: positiveInt(process.env.CONTROLLER_PROCESSING_TIMEOUT_MS, 10 * 60 * 1000),
  shutdownTimeoutMs: positiveInt(process.env.CONTROLLER_SHUTDOWN_TIMEOUT_MS, 30 * 1000),
  cliMaxAttempts: positiveInt(process.env.CONTROLLER_CLI_MAX_ATTEMPTS, 6),
  cliRetryBaseMs: positiveInt(process.env.CONTROLLER_CLI_RETRY_BASE_MS, 1000),
  cliRetryMaxMs: positiveInt(process.env.CONTROLLER_CLI_RETRY_MAX_MS, 15_000),
  daemonArgs: splitArgs(process.env.LIVESYNC_DAEMON_ARGS || "")
};

let daemon = null;
let stopping = false;

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await ensureLayout();

while (!stopping) {
  await recoverPending();
  await recoverProcessing();
  const processed = await processReadyBatch();
  if (stopping) break;
  if (processed > 0) await sleep(Math.min(config.cliRetryBaseMs, 1000));
  await runDaemonUntilMutationOrExit();
}

async function runDaemonUntilMutationOrExit() {
  daemon = spawn(config.cli, livesyncArgs("daemon", ...config.daemonArgs), { stdio: "inherit" });
  const child = daemon;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) }));
  });

  while (!stopping) {
    const exited = await Promise.race([
      exitPromise.then((result) => ({ type: "exit", result })),
      sleep(config.pollIntervalMs).then(() => ({ type: "tick" }))
    ]);
    if (exited.type === "exit") {
      if (daemon === child) daemon = null;
      console.log(JSON.stringify({ level: "warn", message: "livesync daemon exited", ...exited.result }));
      await sleep(config.pollIntervalMs);
      return;
    }
    if (await hasActionableMutation()) {
      await stopDaemon();
      return;
    }
  }

  await stopDaemon();
}

async function hasActionableMutation() {
  if ((await listStateFiles("ready")).length > 0) return true;
  if (await hasStaleState("pending", config.pendingTimeoutMs)) return true;
  return hasStaleState("processing", config.processingTimeoutMs);
}

async function hasStaleState(state, timeoutMs) {
  const now = Date.now();
  for (const file of await listStateFiles(state)) {
    const fileStat = await stat(file).catch(() => undefined);
    if (fileStat && now - fileStat.mtimeMs >= timeoutMs) return true;
  }
  return false;
}

async function processReadyBatch() {
  let processed = 0;
  while (!stopping) {
    const files = await listStateFiles("ready");
    if (files.length === 0) return processed;
    for (const file of files) {
      if (stopping) return processed;
      await processMutation(file);
      processed += 1;
    }
  }
  return processed;
}

async function processMutation(file) {
  let record = await readMutation(file);
  const processingPath = statePath("processing", path.basename(file));
  await rename(file, processingPath);
  record = { ...record, state: "processing", attempt: Number(record.attempt || 0) + 1, updatedAt: new Date().toISOString() };
  await writeJson(processingPath, record);
  await fsyncDir(path.dirname(file));
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
    console.log(JSON.stringify({ level: "info", message: "mutation done", id: record.id, op: record.op, attempt: record.attempt }));
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

async function recoverPending() {
  const files = await listStateFiles("pending");
  const now = Date.now();
  for (const file of files) {
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat || now - fileStat.mtimeMs < config.pendingTimeoutMs) continue;
    const record = await readMutation(file);
    try {
      if (record.op === "delete") {
        const notePath = requiredString(record.path, "path");
        if (await exists(path.join(config.vault, notePath))) {
          await transitionMutation(file, record, "cancelled", { recoveryReason: "pending delete source still exists; filesystem mutation did not complete" });
          console.log(JSON.stringify({ level: "warn", message: "cancelled stale pending delete", id: record.id, path: notePath }));
        } else {
          await transitionMutation(file, record, "ready", { recoveryReason: "pending delete source is absent; recovering completed filesystem mutation" });
          console.log(JSON.stringify({ level: "warn", message: "recovered stale pending delete", id: record.id, path: notePath }));
        }
        continue;
      }

      if (record.op === "move") {
        const oldPath = requiredString(record.oldPath, "oldPath");
        const newPath = requiredString(record.newPath, "newPath");
        const oldExists = await exists(path.join(config.vault, oldPath));
        const newExists = await exists(path.join(config.vault, newPath));
        if (!oldExists) {
          await transitionMutation(file, record, "ready", {
            recoveryReason: newExists
              ? "pending move source is absent and destination exists; recovering completed filesystem mutation"
              : "pending move source and destination are absent; recovering final deleted state"
          });
          console.log(JSON.stringify({ level: "warn", message: "recovered stale pending move", id: record.id, oldPath, newPath, newExists }));
        } else if (!newExists) {
          await transitionMutation(file, record, "cancelled", { recoveryReason: "pending move source exists and destination is absent; filesystem mutation did not complete" });
          console.log(JSON.stringify({ level: "warn", message: "cancelled stale pending move", id: record.id, oldPath, newPath }));
        } else {
          await transitionMutation(file, record, "failed", { error: "stale pending move is ambiguous because source and destination both exist" });
          console.error(JSON.stringify({ level: "error", message: "failed stale pending move recovery", id: record.id, oldPath, newPath }));
        }
        continue;
      }

      await transitionMutation(file, record, "failed", { error: `unsupported mutation op in pending recovery: ${record.op}` });
    } catch (error) {
      await transitionMutation(file, record, "failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function recoverProcessing() {
  const files = await listStateFiles("processing");
  const now = Date.now();
  for (const file of files) {
    const fileStat = await stat(file).catch(() => undefined);
    if (!fileStat || now - fileStat.mtimeMs < config.processingTimeoutMs) continue;
    const record = await readMutation(file);
    await transitionMutation(file, record, "ready", { recoveryReason: "processing timeout; retrying idempotent LiveSync mutation" });
    console.log(JSON.stringify({ level: "warn", message: "recovered processing mutation", id: record.id, op: record.op }));
  }
}

async function transitionMutation(file, record, targetState, patch = {}) {
  const destinationDir = targetState === "done"
    ? path.join(config.mutations, "done", new Date().toISOString().slice(0, 10))
    : path.join(config.mutations, targetState);
  await mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, path.basename(file));
  await writeJson(file, { ...record, ...patch, state: targetState, updatedAt: new Date().toISOString() });
  await rename(file, destination);
  await fsyncDir(path.dirname(file));
  await fsyncDir(destinationDir);
  return destination;
}

async function assertNotActive(notePath) {
  const result = await runCliCapture("info", notePath);
  if (result.code !== 0 && isNotFoundResult(result)) return;
  if (result.code !== 0) throw new Error(`livesync-cli info failed for ${notePath}: ${resultSummary(result)}`);
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
  if (result.code !== 0) throw new Error(`path is not active after mutation: ${notePath}; ${resultSummary(result)}`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not found|file not found|deleted/i.test(output)) {
    throw new Error(`path is not active after mutation: ${notePath}`);
  }
}

async function runCli(command, ...args) {
  const result = await runCliCapture(command, ...args);
  if (result.code !== 0) throw new Error(`livesync-cli ${command} failed: ${resultSummary(result)}`);
}

async function runCliCapture(command, ...args) {
  let lastResult;
  for (let attempt = 1; attempt <= config.cliMaxAttempts; attempt += 1) {
    lastResult = await runCliOnce(command, ...args);
    if (lastResult.code === 0 || !isRetryableCliFailure(lastResult) || attempt === config.cliMaxAttempts) return lastResult;
    const delayMs = Math.min(config.cliRetryBaseMs * (2 ** (attempt - 1)), config.cliRetryMaxMs);
    console.log(JSON.stringify({
      level: "warn",
      message: "retrying livesync-cli after transient database failure",
      command,
      attempt,
      maxAttempts: config.cliMaxAttempts,
      delayMs,
      error: resultSummary(lastResult)
    }));
    await sleep(delayMs);
  }
  return lastResult;
}

async function runCliOnce(command, ...args) {
  return new Promise((resolve) => {
    const child = spawn(config.cli, livesyncArgs(command, ...args), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, ...result });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
    child.once("error", (error) => finish({ code: null, signal: null, spawnError: error instanceof Error ? error.message : String(error) }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

function isRetryableCliFailure(result) {
  const output = `${result.spawnError || ""}\n${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  return /could not initialise database|could not initialize database|leveldb|resource temporarily unavailable|database.*lock|lock.*database|io error.*lock|ebusy|eagain|temporarily locked/.test(output);
}

function isNotFoundResult(result) {
  return /not found|file not found|deleted/i.test(`${result.stdout || ""}\n${result.stderr || ""}`);
}

function resultSummary(result) {
  const text = `${result.spawnError || ""}\n${result.stderr || ""}\n${result.stdout || ""}`.trim().replace(/\s+/g, " ");
  const bounded = text.length > 600 ? `${text.slice(-600)}` : text;
  return `code=${result.code ?? "null"} signal=${result.signal ?? "none"}${bounded ? ` output=${bounded}` : ""}`;
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
