import assert from "node:assert/strict";
import { McpHandler } from "../src/mcp/handler.js";
import type { Tool } from "../src/mcp/types.js";

const outputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false
};

const goodTool: Tool = {
  name: "good_output",
  title: "Good Output",
  description: "Returns valid structured output.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema,
  handler: async () => ({ value: "ok" })
};

const badTool: Tool = {
  name: "bad_output",
  title: "Bad Output",
  description: "Returns output that violates its published contract.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema,
  handler: async () => ({ value: 42 })
};

const handler = new McpHandler([goodTool, badTool]);
const listed = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) as any;
assert.deepEqual(listed.result.tools[0].outputSchema, outputSchema);
assert.deepEqual(listed.result.tools[1].outputSchema, outputSchema);

const good = await handler.handle({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "good_output", arguments: {} }
}) as any;
assert.equal(good.result.isError, false);
assert.equal(good.result.structuredContent.value, "ok");

const bad = await handler.handle({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "bad_output", arguments: {} }
}) as any;
assert.equal(bad.result.isError, true);
assert.equal(bad.result.structuredContent.error.code, "INTERNAL_ERROR");
assert.match(bad.result.structuredContent.error.message, /output failed validation/i);
assert(Array.isArray(bad.result.structuredContent.error.details.issues));

console.log("output contract ok");
