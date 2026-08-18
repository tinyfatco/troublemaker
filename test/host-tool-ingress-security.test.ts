import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHostBashRoute } from "../src/modes/host/index.js";

function invoke(
	authToken: string | undefined,
	headers: Record<string, string>,
	body = JSON.stringify({ tool: "bash", args: { label: "Print working directory", command: "pwd" } }),
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = Readable.from([Buffer.from(body)]) as any;
		req.headers = headers;
		const res = {
			status: 0,
			body: "",
			headersSent: false,
			writeHead(status: number) { this.status = status; this.headersSent = true; return this; },
			write() { return true; },
			end(value = "") { this.body += String(value); resolve({ status: this.status, body: this.body }); return this; },
		};
		const route = createHostBashRoute({
			authToken,
			executor: {
				exec: async () => ({ stdout: "ok", stderr: "", code: 0 }),
			} as any,
		});
		try {
			route(req, res as any);
		} catch (error) {
			reject(error);
		}
	});
}

const token = "host-tool-capability-at-least-32-bytes";
assert.equal((await invoke(undefined, {})).status, 503, "missing capability disables host execution");
assert.equal((await invoke("weak", {})).status, 503, "weak capability disables host execution");
assert.equal((await invoke(token, { "x-tools-token": "wrong" })).status, 401);
assert.equal((await invoke(token, {
	"x-tools-token": token,
	"content-type": "text/plain",
})).status, 415, "cross-site simple content types cannot invoke host execution");
assert.equal((await invoke(token, {
	"x-tools-token": token,
	"content-type": "application/json",
})).status, 200);

console.log("host tool ingress security ok");
