import assert from "node:assert/strict";
import { isHostBashRequest } from "../src/modes/host/protocol.js";

assert.equal(isHostBashRequest({
	tool: "bash",
	args: {
		label: "List files",
		command: "ls",
		timeout: 5,
	},
}), true);

assert.equal(isHostBashRequest({
	tool: "bash",
	args: {
		label: "Missing command",
	},
}), false);

assert.equal(isHostBashRequest({
	tool: "read",
	args: {
		label: "Wrong tool",
		command: "ls",
	},
}), false);

console.log("host-protocol ok");
