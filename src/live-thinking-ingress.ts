import type { IncomingMessage, ServerResponse } from "node:http";
import { LiveThinkingBridge, type LiveThinkingInput } from "./live-thinking-bridge.js";

const json = (res: ServerResponse, status: number, body: unknown): void => {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	res.end(JSON.stringify(body));
};
/** Registered behind the gateway's existing loopback/token boundary. */
export class LiveThinkingIngress {
	constructor(private readonly bridge: LiveThinkingBridge) {}
	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (req.method === "GET") {
			const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("session_id");
			if (!id) { json(res, 200, { ok: true, thinking_bridge: 1 }); return; }
			try {
				if (!this.bridge.isActive(id)) throw new Error("Live session unavailable");
				// Attach before flushing so a second subscriber fails as JSON.
				const backlog: unknown[] = []; let ready = false;
				const write = (update: unknown): void => {
					if (update === null) { res.end(); return; }
					if (!res.write(`data: ${JSON.stringify(update)}\n\n`)) res.destroy();
				};
				const unsubscribe = this.bridge.subscribe(id, update => ready ? write(update) : backlog.push(update));
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
				res.write(': ready\n\n'); ready = true; backlog.forEach(write);
				const keepalive = setInterval(() => { if (!res.write(': alive\n\n')) res.destroy(); }, 15000);
				res.on("close", () => { clearInterval(keepalive); unsubscribe(); if (this.bridge.isActive(id)) this.bridge.close(id); });
			} catch { json(res, 409, { ok: false, error: "Live output unavailable" }); }
			return;
		}
		if (req.method !== "POST") { json(res, 405, { ok: false }); return; }
		if (!String(req.headers["content-type"]).startsWith("application/json")) { json(res, 415, { ok: false }); return; }
		const chunks: Buffer[] = []; let bytes = 0;
		req.on("data", (data: Buffer) => { bytes += data.length; if (bytes <= 64 * 1024) chunks.push(data); });
		req.on("end", () => {
			if (bytes > 64 * 1024) { json(res, 413, { ok: false }); return; }
			try {
				const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!value || typeof value !== "object" || typeof value.session_id !== "string") throw new Error("Invalid live event");
				if (value.type === "thinking.open") this.bridge.open(value.session_id);
				else if (value.type === "thinking.input") this.bridge.accept(value as LiveThinkingInput);
				else if (value.type === "thinking.close") this.bridge.close(value.session_id);
				else throw new Error("Invalid live event type");
				json(res, 200, { ok: true, thinking_bridge: 1 });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Invalid live event";
				json(res, /unavailable|replay|active|order|Conflicting/.test(message) ? 409 : 400, { ok: false, error: message });
			}
		});
		req.on("error", () => { if (!res.headersSent) json(res, 400, { ok: false }); });
	}
}
