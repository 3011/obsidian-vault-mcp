import { randomUUID } from "node:crypto";
import { link, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(targetPath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = tempFilePath(targetPath);
  try {
    await writeAndSync(tempPath, content);
    await rename(tempPath, targetPath);
    await fsyncDir(dir);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicCreateFile(targetPath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = tempFilePath(targetPath);
  let linked = false;
  try {
    await writeAndSync(tempPath, content);
    await link(tempPath, targetPath);
    linked = true;
    await rm(tempPath, { force: true }).catch(() => undefined);
    await fsyncDir(dir);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (linked) {
      // The no-replace link is already committed. A cleanup/fsync error must not
      // be reported as if the target were absent or safe to retry blindly.
      await fsyncDir(dir).catch(() => undefined);
    }
    throw error;
  }
}

async function writeAndSync(filePath: string, content: string | Uint8Array): Promise<void> {
  const file = await open(filePath, "wx", 0o600);
  try {
    if (typeof content === "string") await file.writeFile(content, "utf8");
    else await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("file write made no progress");
    offset += bytesWritten;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

function tempFilePath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
}

export async function atomicCopyFile(sourcePath: string, targetPath: string, overwrite: boolean): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = tempFilePath(targetPath);
  let committed = false;
  try {
    const source = await open(sourcePath, "r");
    const temp = await open(tempPath, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await writeAll(temp, buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await temp.sync();
    } finally {
      await temp.close();
      await source.close();
    }

    if (overwrite) {
      await rename(tempPath, targetPath);
      committed = true;
    } else {
      await link(tempPath, targetPath);
      committed = true;
      await rm(tempPath, { force: true });
    }
    await fsyncDir(dir);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (committed) await fsyncDir(dir).catch(() => undefined);
    throw error;
  }
}
