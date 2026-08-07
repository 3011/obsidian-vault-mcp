import type { NormalizedToolFailure } from "./errors.js";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export function rpcResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: Record<string, unknown>
): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export type EmbeddedResourceResult = {
  __embeddedResource: true;
  structuredContent: Record<string, unknown>;
  resource: {
    uri: string;
    mimeType: string;
    blob: string;
  };
};

export function embeddedResourceResult(
  structuredContent: Record<string, unknown>,
  resource: EmbeddedResourceResult["resource"]
): EmbeddedResourceResult {
  return { __embeddedResource: true, structuredContent, resource };
}

export function structuredContentFor(data: unknown): Record<string, unknown> {
  if (isEmbeddedResourceResult(data)) return data.structuredContent;
  return isRecord(data) ? data : { result: data };
}

export function toolResult(data: unknown): Record<string, unknown> {
  if (isEmbeddedResourceResult(data)) {
    return {
      content: [
        { type: "text", text: JSON.stringify(data.structuredContent, null, 2) },
        {
          type: "resource",
          resource: data.resource,
          annotations: { audience: ["assistant"], priority: 1 }
        }
      ],
      structuredContent: data.structuredContent,
      isError: false
    };
  }
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: structuredContentFor(data),
    isError: false
  };
}

export function toolError(failure: NormalizedToolFailure): Record<string, unknown> {
  return {
    content: [{ type: "text", text: failure.error.message }],
    structuredContent: { ok: false, ...(failure.result ?? {}), error: failure.error },
    isError: true
  };
}

function isEmbeddedResourceResult(value: unknown): value is EmbeddedResourceResult {
  return isRecord(value) && value.__embeddedResource === true && isRecord(value.structuredContent) && isRecord(value.resource);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
