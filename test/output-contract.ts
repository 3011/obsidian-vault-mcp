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

const arrayOutputSchema = {
  type: "object",
  properties: {
    result: { type: "array", items: { type: "string" } }
  },
  required: ["result"],
  additionalProperties: false
};

const arrayTool: Tool = {
  name: "array_output",
  title: "Array Output",
  description: "Returns an array normalized into structuredContent.result.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: arrayOutputSchema,
  handler: async () => ["one", "two"]
};

const handler = new McpHandler([goodTool, badTool, arrayTool]);
const listed = await handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) as any;
assert.deepEqual(listed.result.tools[0].outputSchema, outputSchema);
assert.deepEqual(listed.result.tools[1].outputSchema, outputSchema);
assert.deepEqual(listed.result.tools[2].outputSchema, arrayOutputSchema);

const good = await handler.handle({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "good_output", arguments: {} }
}) as any;
assert.equal(good.result.isError, false);
assert.equal(good.result.structuredContent.value, "ok");

const arrayResult = await handler.handle({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "array_output", arguments: {} }
}) as any;
assert.equal(arrayResult.result.isError, false);
assert.deepEqual(arrayResult.result.structuredContent, { result: ["one", "two"] });

const bad = await handler.handle({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "bad_output", arguments: {} }
}) as any;
assert.equal(bad.result.isError, true);
assert.equal(bad.result.structuredContent.error.code, "INTERNAL_ERROR");
assert.match(bad.result.structuredContent.error.message, /output failed validation/i);
assert(Array.isArray(bad.result.structuredContent.error.details.issues));

console.log("output contract ok");
