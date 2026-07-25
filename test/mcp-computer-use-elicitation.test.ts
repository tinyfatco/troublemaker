import assert from "node:assert/strict";
import { isComputerUseAppApproval } from "../src/mcp-client/bridge.js";

const validApproval = {
	_meta: { persist: ["always"] },
	message: "Allow ChatGPT to use Finder?",
	requestedSchema: {
		type: "object",
		properties: {},
	},
};

assert.equal(isComputerUseAppApproval(validApproval), true);
assert.equal(isComputerUseAppApproval({ ...validApproval, message: "Enter an API key" }), false);
assert.equal(isComputerUseAppApproval({ ...validApproval, _meta: {} }), false);
assert.equal(isComputerUseAppApproval({
	...validApproval,
	requestedSchema: {
		type: "object",
		properties: { secret: { type: "string" } },
	},
}), false);
assert.equal(isComputerUseAppApproval({ ...validApproval, mode: "url" }), false);

console.log("mcp-computer-use-elicitation ok");
