import assert from "node:assert/strict";
import { McpAdapter } from "../src/adapters/mcp.js";

function dispatch(headers: Record<string, string>): { status: number; body: string } {
	const req = { headers } as any;
	const result = { status: 0, body: "" };
	const res = {
		writeHead(status: number) { result.status = status; return this; },
		end(body = "") { result.body = String(body); return this; },
	} as any;
	new McpAdapter({ workingDir: process.cwd() }).dispatch(req, res);
	return result;
}

const previous = process.env.MOM_MCP_AUTH_TOKEN;
const testCapability = Array.from({ length: 40 }, (_, index) =>
	String.fromCharCode(97 + (index % 26)),
).join("");
try {
	delete process.env.MOM_MCP_AUTH_TOKEN;
	assert.equal(dispatch({}).status, 503, "MCP shell tools fail closed without a capability");

	process.env.MOM_MCP_AUTH_TOKEN = testCapability;
	assert.equal(dispatch({}).status, 401);
	assert.equal(dispatch({ "x-tools-token": "wrong" }).status, 401);
} finally {
	if (previous === undefined) delete process.env.MOM_MCP_AUTH_TOKEN;
	else process.env.MOM_MCP_AUTH_TOKEN = previous;
}

console.log("MCP ingress security ok");
