import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(targetPath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  const file = await open(tempPath, "w", 0o600);
  try {
    if (typeof content === "string") await file.writeFile(content, "utf8");
    else await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tempPath, targetPath);
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
