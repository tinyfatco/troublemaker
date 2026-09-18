import type { IncomingMessage, ServerResponse } from "http";
import type { LocalDuplexTranscriptTurn } from "./agent.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface LocalDuplexIngressTarget {
	append(turn: LocalDuplexTranscriptTurn): Promise<void>;
	close(sessionId: string): Promise<void>;
	observe?(turn: LocalDuplexTranscriptTurn): void;
	closeObservation?(sessionId: string): void;
	observationsHealthy?(): boolean;
}

interface TranscriptPayload {
	type: "transcript" | "transcript.observation";
	session_id: string;
	sequence: number;
	role: "user" | "assistant";
	text: string;
	timestamp_ms: number;
}

interface ClosePayload {
	type: "session.closed" | "observation.closed";
	session_id: string;
}

type LocalDuplexPayload = TranscriptPayload | ClosePayload;

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(value: unknown): LocalDuplexPayload {
	if (!isRecord(value)) throw new Error("Expected a JSON object");
	if (value.type === "session.closed" || value.type === "observation.closed") {
		if (typeof value.session_id !== "string") throw new Error("Missing session_id");
		return { type: value.type, session_id: value.session_id };
	}
	if (value.type !== "transcript" && value.type !== "transcript.observation") throw new Error("Unsupported local duplex event type");
	if (typeof value.session_id !== "string") throw new Error("Missing session_id");
	if (!Number.isSafeInteger(value.sequence)) throw new Error("Invalid sequence");
	if (value.role !== "user" && value.role !== "assistant") throw new Error("Invalid role");
	if (value.type === "transcript.observation" && value.role !== "user") throw new Error("Invalid live observation role");
	if (typeof value.text !== "string") throw new Error("Invalid text");
	if (!Number.isSafeInteger(value.timestamp_ms)) throw new Error("Invalid timestamp_ms");
	return {
		type: value.type,
		session_id: value.session_id,
		sequence: value.sequence as number,
		role: value.role,
		text: value.text,
		timestamp_ms: value.timestamp_ms as number,
	};
}

function statusForError(error: unknown): number {
	const message = error instanceof Error ? error.message : String(error);
	if (/out-of-order|conflicting|closed/i.test(message)) return 409;
	if (/invalid|missing|expected|unsupported|must begin/i.test(message)) return 400;
	return 500;
}

export class LocalDuplexIngress {
	constructor(private readonly target: LocalDuplexIngressTarget) {}

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (req.method === "GET") {
			const supported = Boolean(this.target.observe) && (this.target.observationsHealthy?.() ?? true);
			sendJSON(res, supported ? 200 : 503, { ok: supported, live_observations: supported });
			return;
		}
		if (req.method !== "POST") {
			sendJSON(res, 405, { ok: false, error: "Method not allowed" });
			return;
		}
		const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
		if (!contentType.startsWith("application/json")) {
			sendJSON(res, 415, { ok: false, error: "Content-Type must be application/json" });
			return;
		}

		const chunks: Buffer[] = [];
		let bytes = 0;
		let tooLarge = false;
		req.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				tooLarge = true;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (tooLarge) {
				sendJSON(res, 413, { ok: false, error: "Local duplex event is too large" });
				return;
			}
			void this.apply(Buffer.concat(chunks), res);
		});
		req.on("error", (error) => sendJSON(res, 400, { ok: false, error: error.message }));
	}

	private async apply(body: Buffer, res: ServerResponse): Promise<void> {
		try {
			let decoded: unknown;
			try {
				decoded = JSON.parse(body.toString("utf8"));
			} catch {
				throw new Error("Invalid JSON body");
			}
			const payload = parsePayload(decoded);
			if (payload.type === "session.closed") {
				await this.target.close(payload.session_id);
			} else if (payload.type === "observation.closed") {
				if (!this.target.closeObservation) throw new Error("Unsupported live observations");
				this.target.closeObservation(payload.session_id);
			} else if ("sequence" in payload) {
				const turn: LocalDuplexTranscriptTurn = {
					sessionId: payload.session_id,
					sequence: payload.sequence,
					role: payload.role,
					text: payload.text,
					timestamp: payload.timestamp_ms,
					...(payload.type === "transcript.observation" ? { observation: true } : {}),
				};
				if (payload.type === "transcript.observation") {
					if (!this.target.observe) throw new Error("Unsupported live observations");
					this.target.observe(turn);
				} else await this.target.append(turn);
			}
			sendJSON(res, 200, { ok: true, live_observations: Boolean(this.target.observe) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJSON(res, statusForError(error), { ok: false, error: message });
		}
	}
}
