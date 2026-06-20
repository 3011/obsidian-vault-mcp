import { config } from "../config.js";
import type { JsonRpcRequest, Tool } from "./types.js";
import { rpcError, rpcResult, toolError, toolResult } from "./types.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];

export class McpHandler {
  private readonly tools: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async handle(message: JsonRpcRequest, protocolVersion?: string): Promise<Record<string, unknown> | null> {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id, -32600, "Invalid Request");
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (!hasId) return null;
    if (message.id == null) return rpcError(null, -32600, "Invalid Request");

    if (message.method === "initialize") {
      const params = message.params ?? {};
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return rpcResult(message.id, {
        protocolVersion: protocolVersion || (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]),
        capabilities: { tools: {} },
        serverInfo: {
          name: config.serverName,
          version: config.serverVersion,
          title: "Obsidian Vault MCP"
        },
        instructions: "Operate on a headless Obsidian Markdown vault. Destructive write, delete, and move tools are enabled by operator choice."
      });
    }

    if (message.method === "ping") return rpcResult(message.id, {});
    if (message.method === "tools/list") {
      return rpcResult(message.id, {
        tools: [...this.tools.values()].map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
    }
    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = params.name;
      if (typeof name !== "string") return rpcError(message.id, -32602, "params.name is required");
      const tool = this.tools.get(name);
      if (!tool) return rpcError(message.id, -32601, `Unknown tool: ${name}`);
      try {
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        return rpcResult(message.id, toolResult(await tool.handler(args)));
      } catch (error) {
        return rpcResult(message.id, toolError(error instanceof Error ? error.message : String(error)));
      }
    }
    return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }

  supportedProtocolVersions(): string[] {
    return SUPPORTED_PROTOCOL_VERSIONS;
  }
}
