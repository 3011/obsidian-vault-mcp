import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export type AuditDetails = Record<string, unknown>;

export async function audit(tool: string, status: "success" | "failure", details: AuditDetails): Promise<void> {
  if (!config.enableAuditLog) return;
  const event = {
    level: status === "success" ? "info" : "error",
    event: "vault_mutation",
    tool,
    status,
    ...details,
    timestamp: new Date().toISOString()
  };
  const line = `${JSON.stringify(event)}\n`;
  try {
    if (config.auditLogPath) {
      await mkdir(path.dirname(config.auditLogPath), { recursive: true });
      await appendFile(config.auditLogPath, line, "utf8");
    } else {
      console.log(line.trimEnd());
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "audit_log_write_failed",
      path: config.auditLogPath,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    }));
  }
}
