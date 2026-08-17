import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { ConsoleTranscriptionError, type ConsoleTranscriptionResult } from "./transcription.js";

interface TranscriptionLedgerRecord {
	version: 1;
	id: string;
	audio_digest: string;
	text: string;
	created_at: string;
}

interface InFlightTranscription {
	audioDigest: string;
	result: Promise<ConsoleTranscriptionResult>;
}

/**
 * Durable, content-addressed transcription reconciliation.
 *
 * The ledger stores only the stable request identity, an audio digest, and the
 * exact successful transcript. Raw audio and provider responses are never
 * written. Reusing an identity with different audio fails closed.
 */
export class ConsoleTranscriptionLedger {
	private readonly records = new Map<string, TranscriptionLedgerRecord>();
	private readonly inFlight = new Map<string, InFlightTranscription>();

	constructor(
		private readonly path: string,
		private readonly limit = 512,
	) {
		if (!path.startsWith("/")) throw new Error("Transcription ledger path must be absolute");
		this.load();
	}

	async resolve(
		id: string,
		audio: Uint8Array,
		producer: () => Promise<ConsoleTranscriptionResult>,
	): Promise<ConsoleTranscriptionResult> {
		const audioDigest = createHash("sha256").update(audio).digest("hex");
		const existing = this.records.get(id);
		if (existing) {
			if (existing.audio_digest !== audioDigest) throw identityConflict();
			return { text: existing.text };
		}

		const active = this.inFlight.get(id);
		if (active) {
			if (active.audioDigest !== audioDigest) throw identityConflict();
			return active.result;
		}

		const result = (async () => {
			const produced = await producer();
			const text = produced.text.trim();
			if (!text) {
				throw new ConsoleTranscriptionError(422, "no_speech_detected", "No speech was detected");
			}
			const record: TranscriptionLedgerRecord = {
				version: 1,
				id,
				audio_digest: audioDigest,
				text,
				created_at: new Date().toISOString(),
			};
			this.records.set(id, record);
			this.persist();
			return { text };
		})();
		this.inFlight.set(id, { audioDigest, result });
		try {
			return await result;
		} finally {
			this.inFlight.delete(id);
		}
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const stat = lstatSync(this.path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error("Transcription ledger must be a regular file");
		}
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let record: TranscriptionLedgerRecord;
			try {
				record = JSON.parse(line) as TranscriptionLedgerRecord;
			} catch {
				throw new Error("Transcription ledger is unreadable");
			}
			if (!isRecord(record)) throw new Error("Transcription ledger is unreadable");
			this.records.set(record.id, record);
		}
		this.trim();
	}

	private persist(): void {
		this.trim();
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp-${process.pid}`;
		const body = [...this.records.values()].map((record) => JSON.stringify(record)).join("\n");
		writeFileSync(temporary, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}

	private trim(): void {
		const maximum = Math.max(1, this.limit);
		while (this.records.size > maximum) {
			const oldest = this.records.keys().next().value as string | undefined;
			if (!oldest) break;
			this.records.delete(oldest);
		}
	}
}

function isRecord(value: TranscriptionLedgerRecord): boolean {
	return value?.version === 1
		&& typeof value.id === "string"
		&& /^[A-Za-z0-9._:-]{8,128}$/.test(value.id)
		&& typeof value.audio_digest === "string"
		&& /^[a-f0-9]{64}$/.test(value.audio_digest)
		&& typeof value.text === "string"
		&& value.text.length > 0
		&& value.text.length <= 100_000
		&& typeof value.created_at === "string";
}

function identityConflict(): ConsoleTranscriptionError {
	return new ConsoleTranscriptionError(
		409,
		"transcription_identity_conflict",
		"The transcription identity was already used for different audio",
	);
}
