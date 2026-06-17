export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export function rpcResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: isRecord(data) ? data : { result: data },
    isError: false
  };
}

export function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
