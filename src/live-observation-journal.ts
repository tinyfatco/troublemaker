import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalDuplexTranscriptTurn } from "./agent.js";

type Event = { kind: "append"; turn: LocalDuplexTranscriptTurn } | { kind: "close"; sessionId: string };
interface Session { next: number; closed: boolean; digests: Record<string, string> }
interface State { version: 1; sessions: Record<string, Session>; pending: Event[]; inFlight: boolean }

/** Durable acceptance must not wait behind an agent's running inference/tools.
 * Canonical appends still use that runner's operation queue. A crash during an
 * append is deliberately quarantined, not blindly replayed into private context.
 */
export class LiveObservationJournal {
	private state: State;
	private running = false;
	private blocked = false;
	constructor(private readonly file: string, private readonly target: {
		append(turn: LocalDuplexTranscriptTurn): Promise<void>;
		close(sessionId: string): Promise<void>;
	}) {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) :
			{ version: 1, sessions: {}, pending: [], inFlight: false };
		if (this.state.version !== 1 || !Array.isArray(this.state.pending) || !this.state.sessions) {
			throw new Error("Invalid live observation journal");
		}
		this.blocked = this.state.inFlight;
		if (!this.blocked) void this.drain();
	}
	get healthy(): boolean { return !this.blocked; }
	get pendingCount(): number { return this.state.pending.length; }

	accept(turn: LocalDuplexTranscriptTurn): void {
		this.checkHealthy(); this.validateID(turn.sessionId);
		if (turn.observation !== true || turn.role !== "user" || !Number.isSafeInteger(turn.sequence) || turn.sequence < 0 ||
			!Number.isSafeInteger(turn.timestamp) || turn.timestamp <= 0 || typeof turn.text !== "string" ||
			!turn.text.trim() || turn.text.length > 40_000) throw new Error("Invalid live observation");
		const digest = createHash("sha256").update(JSON.stringify(turn)).digest("hex");
		let session = Object.hasOwn(this.state.sessions, turn.sessionId) ? this.state.sessions[turn.sessionId] : undefined;
		if (!session) {
			if (turn.sequence !== 0) throw new Error("Live observation must begin at sequence 0");
			this.pruneSessions();
			if (Object.keys(this.state.sessions).length >= 64) throw new Error("Live observation session limit");
			session = { next: 0, closed: false, digests: {} };
		}
		if (session.digests[turn.sequence] === digest) return;
		if (session.digests[turn.sequence]) throw new Error("Conflicting live observation replay");
		if (session.closed) throw new Error("Live observation session is closed");
		if (turn.sequence !== session.next) throw new Error("Out-of-order live observation sequence");
		if (Buffer.byteLength(JSON.stringify(this.state.pending)) + Buffer.byteLength(turn.text) > 4 * 1024 * 1024 ||
			this.state.pending.length >= 4096) throw new Error("Live observation journal capacity exceeded");
		session.next += 1; session.digests[turn.sequence] = digest;
		const old = Object.keys(session.digests).map(Number).sort((a, b) => a - b);
		while (old.length > 256) delete session.digests[old.shift()!];
		this.state.sessions[turn.sessionId] = session;
		this.state.pending.push({ kind: "append", turn });
		this.persist();
		void this.drain();
	}

	close(sessionId: string): void {
		this.checkHealthy(); this.validateID(sessionId);
		const session = Object.hasOwn(this.state.sessions, sessionId) ? this.state.sessions[sessionId] : undefined;
		if (!session || session.closed) return;
		session.closed = true;
		this.state.pending.push({ kind: "close", sessionId });
		this.persist(); void this.drain();
	}
	private validateID(id: string): void {
		if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) {
			throw new Error("Invalid live observation session ID");
		}
	}
	private checkHealthy(): void {
		if (this.blocked) throw new Error("Live observation journal is blocked; retained observations require reconciliation");
	}
	private pruneSessions(): void {
		for (const [id, session] of Object.entries(this.state.sessions)) {
			if (Object.keys(this.state.sessions).length < 64) break;
			if (session.closed && !this.state.pending.some(e => (e.kind === "append" ? e.turn.sessionId : e.sessionId) === id)) {
				delete this.state.sessions[id];
			}
		}
	}
	private persist(): void {
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temp, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(temp, this.file);
			const dir = openSync(dirname(this.file), "r");
			try { fsyncSync(dir); } finally { closeSync(dir); }
		} catch (error) { this.blocked = true; throw error; }
	}
	private async drain(): Promise<void> {
		if (this.running || this.blocked) return;
		this.running = true;
		try {
			while (this.state.pending.length) {
				const event = this.state.pending[0];
				this.state.inFlight = true; this.persist();
				if (event.kind === "append") await this.target.append(event.turn);
				else await this.target.close(event.sessionId);
				this.state.pending.shift(); this.state.inFlight = false; this.persist();
			}
		} catch { this.blocked = true; } // Content retained on disk; never guess/replay an ambiguous append.
		finally { this.running = false; }
	}
}
