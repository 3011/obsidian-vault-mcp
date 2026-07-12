import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { config } from "../config.js";
import { normalizeToolError, ToolDomainError } from "./errors.js";
import type { JsonRpcRequest, Tool } from "./types.js";
import { rpcError, rpcResult, toolError, toolResult } from "./types.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];

export class McpHandler {
  private readonly tools: Map<string, Tool>;
  private readonly validators: Map<string, ValidateFunction>;
  private readonly outputValidators: Map<string, ValidateFunction>;

  constructor(tools: Tool[]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    const ajv = new Ajv2020({
      allErrors: true,
      removeAdditional: false,
      useDefaults: false,
      coerceTypes: false,
      strict: true
    });
    this.validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
    this.outputValidators = new Map(
      tools
        .filter((tool) => tool.outputSchema !== undefined)
        .map((tool) => [tool.name, ajv.compile(tool.outputSchema as Record<string, unknown>)])
    );
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
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {})
        }))
      });
    }
    if (message.method === "tools/call") {
      const params = message.params ?? {};
      const name = params.name;
      if (typeof name !== "string") {
        return rpcError(message.id, -32602, "Invalid params", {
          errorCode: "INVALID_ARGUMENT",
          issues: [{ path: "/name", message: "must be string" }]
        });
      }
      const tool = this.tools.get(name);
      if (!tool) {
        return rpcError(message.id, -32602, "Invalid params", {
          errorCode: "INVALID_ARGUMENT",
          tool: name,
          issues: [{ path: "/name", message: `unknown tool: ${name}` }]
        });
      }
      const rawArguments = params.arguments ?? {};
      if (!isRecord(rawArguments)) {
        return invalidArguments(message.id, name, [{ instancePath: "", message: "must be object" }]);
      }
      const validator = this.validators.get(name);
      if (!validator || !validator(rawArguments)) {
        return invalidArguments(message.id, name, validator?.errors ?? []);
      }
      try {
        const data = await tool.handler(rawArguments);
        const outputValidator = this.outputValidators.get(name);
        if (outputValidator && !outputValidator(data)) {
          throw new ToolDomainError("INTERNAL_ERROR", `Tool output failed validation: ${name}`, {
            details: {
              tool: name,
              issues: formatValidationIssues(outputValidator.errors ?? [])
            }
          });
        }
        return rpcResult(message.id, toolResult(data));
      } catch (error) {
        return rpcResult(message.id, toolError(normalizeToolError(error)));
      }
    }
    return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }

  supportedProtocolVersions(): string[] {
    return SUPPORTED_PROTOCOL_VERSIONS;
  }
}

function invalidArguments(
  id: JsonRpcRequest["id"],
  tool: string,
  errors: Array<Pick<ErrorObject, "instancePath" | "message" | "keyword" | "params"> | { instancePath: string; message: string }>
): Record<string, unknown> {
  return rpcError(id, -32602, "Invalid tool arguments", {
    errorCode: "INVALID_ARGUMENT",
    tool,
    issues: formatValidationIssues(errors)
  });
}

function formatValidationIssues(
  errors: Array<Pick<ErrorObject, "instancePath" | "message" | "keyword" | "params"> | { instancePath: string; message: string }>
): Array<Record<string, unknown>> {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message || "invalid value",
    ...("keyword" in error ? { keyword: error.keyword } : {}),
    ...("params" in error ? { params: error.params } : {})
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
