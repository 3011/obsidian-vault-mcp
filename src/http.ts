import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { McpHandler } from "./mcp/handler.js";

export function createHttpServer(mcp: McpHandler) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", buildBaseUrl(req));
      if (req.method === "OPTIONS") return sendOptions(req, res);
      if (url.pathname === "/healthz") return sendText(req, res, 200, "ok");
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return sendJson(req, res, 200, { resource: buildBaseUrl(req), bearer_methods_supported: ["header"] });
      }
      if (url.pathname !== config.mcpPath) return sendJson(req, res, 404, { error: "not_found" });
      if (!authorize(req, res)) return;

      if (req.method === "GET" || req.method === "HEAD") {
        return sendJson(req, res, 200, {
          status: "ok",
          transport: "streamable-http",
          endpoint: config.mcpPath,
          serverInfo: { name: config.serverName, version: config.serverVersion }
        });
      }
      if (req.method !== "POST") return sendJson(req, res, 405, { error: "method_not_allowed" });

      const protocolVersion = header(req, "mcp-protocol-version");
      if (protocolVersion && !mcp.supportedProtocolVersions().includes(protocolVersion)) {
        return sendJson(req, res, 400, { error: "unsupported_protocol_version", supported: mcp.supportedProtocolVersions() });
      }
      const message = JSON.parse(await readBody(req, config.maxRequestBytes) || "null");
      const response = await mcp.handle(message, protocolVersion);
      if (response == null) return sendEmpty(req, res, 202);
      return sendJson(req, res, 200, response);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(req, res, error.status, { error: "request_error", message: error.message });
      }
      return sendJson(req, res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  if (!config.requireToken) return true;
  if (!config.token) {
    sendJson(req, res, 503, { error: "mcp_token_not_configured" });
    return false;
  }
  const auth = header(req, "authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    sendJson(req, res, 401, { error: "unauthorized", message: "Bearer token required." }, {
      "www-authenticate": `Bearer resource_metadata="${buildBaseUrl(req)}/.well-known/oauth-protected-resource"`
    });
    return false;
  }
  const actual = Buffer.from(auth.slice(7).trim());
  const expected = Buffer.from(config.token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    sendJson(req, res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

function buildBaseUrl(req: IncomingMessage): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = header(req, "host") || `localhost:${config.port}`;
  const proto = header(req, "x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

function sendOptions(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(204, {
    ...corsHeaders(req),
    allow: "GET, HEAD, POST, OPTIONS",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, authorization, accept",
    "access-control-max-age": "600"
  });
  res.end();
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...corsHeaders(req), ...headers, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  if (req.method !== "HEAD") res.end(payload);
  else res.end();
}

function sendText(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...corsHeaders(req), "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
  if (req.method !== "HEAD") res.end(body);
  else res.end();
}

function sendEmpty(req: IncomingMessage, res: ServerResponse, status: number): void {
  res.writeHead(status, corsHeaders(req));
  res.end();
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = header(req, "origin");
  if (!origin) return {};
  if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes("*") && !config.allowedOrigins.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const lengthHeader = header(req, "content-length");
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
