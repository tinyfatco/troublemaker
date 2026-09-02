import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	openSync,
	writeSync,
} from "node:fs";
import type {
	ConsoleAccessVoiceTimingDiagnostic,
	ConsoleAccessVoiceTimingStage,
} from "./console-access-facade.js";

const STAGES = new Set<ConsoleAccessVoiceTimingStage>([
	"request_body_received",
	"authorization_verified",
	"upstream_request_started",
	"upstream_response_received",
	"response_completed",
]);
const DEFAULT_MAXIMUM_BYTES = 1_048_576;

/**
 * Owner-only bounded JSONL sink for a deployment facade overlay. Records are
 * already content-free; this class validates the exact shape again before any
 * write and truncates the one active file at its bound rather than creating an
 * unbounded archive set.
 */
export class BoundedConsoleAccessVoiceTimingFile {
	private readonly descriptor: number;
	private bytes: number;
	private closed = false;

	constructor(
		path: string,
		private readonly maximumBytes = DEFAULT_MAXIMUM_BYTES,
	) {
		if (!path.startsWith("/")
			|| !Number.isSafeInteger(maximumBytes)
			|| maximumBytes < 4_096
			|| maximumBytes > 16 * 1_048_576) {
			throw new Error("Invalid facade voice timing file configuration");
		}
		this.descriptor = openSync(
			path,
			constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		const stat = fstatSync(this.descriptor);
		if (!stat.isFile()) {
			closeSync(this.descriptor);
			throw new Error("Facade voice timing target must be a regular file");
		}
		fchmodSync(this.descriptor, 0o600);
		this.bytes = stat.size;
		if (this.bytes > maximumBytes) {
			ftruncateSync(this.descriptor, 0);
			this.bytes = 0;
		}
	}

	readonly observe = (diagnostic: ConsoleAccessVoiceTimingDiagnostic): void => {
		if (this.closed) return;
		const record = validateDiagnostic(diagnostic);
		const line = Buffer.from(`${JSON.stringify(record)}\n`);
		if (line.byteLength > this.maximumBytes) return;
		if (this.bytes + line.byteLength > this.maximumBytes) {
			ftruncateSync(this.descriptor, 0);
			this.bytes = 0;
		}
		writeSync(this.descriptor, line);
		this.bytes += line.byteLength;
	};

	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeSync(this.descriptor);
	}
}

function validateDiagnostic(
	value: ConsoleAccessVoiceTimingDiagnostic,
): ConsoleAccessVoiceTimingDiagnostic {
	const keys = Object.keys(value).sort();
	const expected = [
		"elapsed_milliseconds",
		...(value.http_status === undefined ? [] : ["http_status"]),
		"ordinal",
		"request_correlation",
		"runtime_identity",
		"session_correlation",
		"source_identity",
		"stage",
		"version",
	].sort();
	if (JSON.stringify(keys) !== JSON.stringify(expected)
		|| value.version !== "computer.voice-facade-timing.v1"
		|| !STAGES.has(value.stage)
		|| !Number.isSafeInteger(value.ordinal)
		|| value.ordinal < 1
		|| value.ordinal > STAGES.size
		|| !Number.isSafeInteger(value.elapsed_milliseconds)
		|| value.elapsed_milliseconds < 0
		|| !isCorrelation(value.request_correlation)
		|| !isCorrelation(value.session_correlation)
		|| !isIdentity(value.runtime_identity)
		|| !isIdentity(value.source_identity)
		|| (value.http_status !== undefined
			&& (!Number.isSafeInteger(value.http_status)
				|| value.http_status < 100
				|| value.http_status > 599))) {
		throw new Error("Invalid facade voice timing diagnostic");
	}
	return value;
}

function isCorrelation(value: string): boolean {
	return /^sha256:[a-f0-9]{24}$/.test(value);
}

function isIdentity(value: string): boolean {
	return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
