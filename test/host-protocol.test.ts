import assert from "node:assert/strict";
import { isHostBashRequest, isHostToolExecuteRequest } from "../src/modes/host/protocol.js";

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

assert.equal(isHostToolExecuteRequest({
	tool: "write",
	args: {
		label: "Write file",
		path: "note.txt",
		content: "hello",
	},
}), true);

assert.equal(isHostToolExecuteRequest({
	tool: "",
	args: {},
}), false);

console.log("host-protocol ok");
