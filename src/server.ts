import { config } from "./config.js";
import { createHttpServer } from "./http.js";
import { buildTools } from "./mcp/tools.js";
import { McpHandler } from "./mcp/handler.js";
import { FsVault } from "./vault/FsVault.js";

const vault = new FsVault(config.vaultRoot, config.defaultWriteDir, {
  assetsDirName: config.assetsDirName,
  maxImageAssetBytes: config.maxImageAssetBytes,
  allowedImageMimeTypes: config.allowedImageMimeTypes
});
await vault.init();

const server = createHttpServer(new McpHandler(buildTools(vault)));
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: "info",
    message: "obsidian-vault-mcp started",
    host: config.host,
    port: config.port,
    endpoint: config.mcpPath,
    vaultRoot: config.vaultRoot,
    defaultWriteDir: config.defaultWriteDir,
    tokenRequired: config.requireToken
  }));
});
