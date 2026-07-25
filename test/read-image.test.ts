import assert from "node:assert/strict";
import type { Executor, ExecResult } from "../src/sandbox.js";
import { createReadTool, MAX_READ_IMAGE_BYTES } from "../src/tools/read.js";

function result(stdout: string, options: Partial<ExecResult> = {}): ExecResult {
	return {
		stdout,
		stderr: "",
		code: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		...options,
	};
}

function executorFor(results: ExecResult[]): Executor {
	return {
		async exec() {
			const next = results.shift();
			if (!next) throw new Error("Unexpected executor call");
			return next;
		},
		getWorkspacePath(path) {
			return path;
		},
	};
}

{
	const tool = createReadTool(executorFor([result(String(MAX_READ_IMAGE_BYTES + 1))]));
	await assert.rejects(
		() => tool.execute("read-large", { label: "Inspecting a large screenshot", path: "large.png" }),
		/exceeds the 5\.0MB read limit.*Resize or compress/s,
	);
}

{
	const tool = createReadTool(executorFor([
		result("1024"),
		result("iVBORw0KGgoAAA", { stdoutTruncated: true }),
	]));
	await assert.rejects(
		() => tool.execute("read-truncated", { label: "Inspecting a screenshot", path: "screen.png" }),
		/exceeded the executor output limit/,
	);
}

{
	const tool = createReadTool(executorFor([
		result("9"),
		result("aW1nIGJ5dGVz\n"),
	]));
	const output = await tool.execute("read-valid", { label: "Inspecting a small screenshot", path: "screen.png" });
	assert.deepEqual(output.content, [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: "aW1nIGJ5dGVz", mimeType: "image/png" },
	]);
}

console.log("read image tests passed");
