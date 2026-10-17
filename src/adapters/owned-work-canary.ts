import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";

export const OWNED_WORK_CANARY_SOCKET = "/run/troublemaker-hostd/computer-control/owned-work-canary.sock";
const MAX_DEADLINE_MS = 180_000;

export interface OwnedWorkCanaryAuthorization {
	version: 1;
	nonce: string;
	contextId: string;
	deliveryId: string;
	source: "zulip";
	senderId: number;
	channelId: string;
	topic: string;
	bodySha256: string;
	expiresAt: string;
	candidateSha: string;
	leaseSeconds: number;
	deadlineMs: number;
}

export interface OwnedWorkCanaryMessageBinding {
	contextId: string;
	deliveryId: string;
	senderId: number;
	channelId: string;
	topic: string;
	body: string;
	runtimeVersion: string;
}

export interface OwnedWorkCanaryBarrier {
	holdWork(): Promise<void>;
	holdReceipt(): Promise<void>;
	holdResponse(): Promise<void>;
	receiptRejected(error: unknown): Promise<void>;
	workSettled(): Promise<void>;
	dispose(): Promise<void>;
}

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	settled: boolean;
};

function deferred(): Deferred {
	let resolvePromise!: () => void;
	let rejectPromise!: (error: Error) => void;
	const value: Deferred = {
		promise: new Promise<void>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		}),
		resolve: () => {},
		reject: () => {},
		settled: false,
	};
	// Attach an observer immediately. Callers still receive the same rejection.
	void value.promise.catch(() => {});
	value.resolve = () => {
		if (value.settled) return;
		value.settled = true;
		resolvePromise();
	};
	value.reject = (error) => {
		if (value.settled) return;
		value.settled = true;
		rejectPromise(error);
	};
	return value;
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value as Record<string, unknown>).sort();
	return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function safeText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
}

export function validateOwnedWorkCanaryAuthorization(
	value: unknown,
	binding: OwnedWorkCanaryMessageBinding,
	nowMs = Date.now(),
): OwnedWorkCanaryAuthorization {
	const keys = [
		"version", "nonce", "contextId", "deliveryId", "source", "senderId", "channelId",
		"topic", "bodySha256", "expiresAt", "candidateSha", "leaseSeconds", "deadlineMs",
	];
	if (!exactObject(value, keys)) throw new Error("owned_work_canary_invalid_shape");
	const authorization = value as unknown as OwnedWorkCanaryAuthorization;
	if (
		authorization.version !== 1
		|| authorization.source !== "zulip"
		|| !safeText(authorization.nonce, 128)
		|| !safeText(authorization.contextId, 256)
		|| !safeText(authorization.deliveryId, 256)
		|| !Number.isInteger(authorization.senderId)
		|| authorization.senderId < 1
		|| !safeText(authorization.channelId, 64)
		|| !safeText(authorization.topic, 256)
		|| !/^[a-f0-9]{64}$/.test(authorization.bodySha256)
		|| !/^[a-f0-9]{40}$/.test(authorization.candidateSha)
		|| !Number.isInteger(authorization.leaseSeconds)
		|| authorization.leaseSeconds < 3
		|| authorization.leaseSeconds > 20
		|| !Number.isInteger(authorization.deadlineMs)
		|| authorization.deadlineMs < 1_000
		|| authorization.deadlineMs > MAX_DEADLINE_MS
	) throw new Error("owned_work_canary_invalid_fields");
	const expiresAt = Date.parse(authorization.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt > nowMs + MAX_DEADLINE_MS) {
		throw new Error("owned_work_canary_expired");
	}
	if (binding.body.trim().toLowerCase() === "stop" || binding.body.trim().startsWith("/")) {
		throw new Error("owned_work_canary_control_body_denied");
	}
	const bodySha256 = createHash("sha256").update(binding.body, "utf8").digest("hex");
	if (
		authorization.contextId !== binding.contextId
		|| authorization.deliveryId !== binding.deliveryId
		|| authorization.senderId !== binding.senderId
		|| authorization.channelId !== binding.channelId
		|| authorization.topic !== binding.topic
		|| authorization.bodySha256 !== bodySha256
		|| !(
			binding.runtimeVersion === authorization.candidateSha
			|| binding.runtimeVersion.startsWith(`${authorization.candidateSha}-`)
		)
	) throw new Error("owned_work_canary_binding_mismatch");
	return authorization;
}

function writeFrame(socket: Socket, frame: Record<string, unknown>): void {
	const encoded = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(encoded) > 4096) throw new Error("owned_work_canary_frame_too_large");
	if (!socket.write(encoded)) throw new Error("owned_work_canary_socket_backpressure");
}

export async function createOwnedWorkCanaryBarrier(
	authorization: OwnedWorkCanaryAuthorization,
	options: { socketPath?: string } = {},
): Promise<OwnedWorkCanaryBarrier> {
	const socketPath = options.socketPath ?? OWNED_WORK_CANARY_SOCKET;
	const stat = await lstat(socketPath);
	if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o007) !== 0) {
		throw new Error("owned_work_canary_socket_unsafe");
	}
	const armed = deferred();
	const responseRelease = deferred();
	const receiptRelease = deferred();
	const workRelease = deferred();
	let socket: Socket | undefined;
	let buffer = "";
	let responseWaiting = false;
	let receiptWaiting = false;
	let workWaiting = false;
	let responseReleased = false;
	let receiptReleased = false;
	let receiptRejected = false;
	let workReleased = false;
	let workSettled = false;
	let disposed = false;
	let terminalError: Error | undefined;

	const fail = (error: Error) => {
		if (terminalError) return;
		terminalError = error;
		armed.reject(error);
		responseRelease.reject(error);
		receiptRelease.reject(error);
		workRelease.reject(error);
	};
	const deadline = setTimeout(() => {
		fail(new Error("owned_work_canary_deadline"));
		socket?.destroy();
	}, authorization.deadlineMs);
	deadline.unref();

	try {
		socket = createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			socket!.once("connect", resolve);
			socket!.once("error", reject);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 8192) {
				fail(new Error("owned_work_canary_protocol_overflow"));
				socket?.destroy();
				return;
			}
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line) as Record<string, unknown>;
				} catch {
					fail(new Error("owned_work_canary_protocol_invalid"));
					continue;
				}
				if (frame.v !== 1 || frame.nonce !== authorization.nonce || typeof frame.type !== "string") {
					fail(new Error("owned_work_canary_protocol_mismatch"));
					continue;
				}
				if (frame.type === "armed" && !armed.settled) {
					armed.resolve();
				} else if (
					frame.type === "release_response"
					&& responseWaiting
					&& receiptWaiting
					&& workWaiting
					&& !responseReleased
				) {
					responseReleased = true;
					responseRelease.resolve();
				} else if (frame.type === "release_receipt" && responseReleased && receiptWaiting && workWaiting && !receiptReleased) {
					receiptReleased = true;
					receiptRelease.resolve();
				} else if (frame.type === "release_work" && receiptRejected && !workReleased) {
					workReleased = true;
					workRelease.resolve();
				} else if (frame.type === "abort") {
					fail(new Error("owned_work_canary_aborted"));
				} else {
					fail(new Error("owned_work_canary_protocol_order"));
				}
			}
		});
		socket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
		socket.on("close", () => {
			if (!disposed && !workSettled) fail(new Error("owned_work_canary_controller_lost"));
		});
		writeFrame(socket, { v: 1, type: "consume", authorization });
		await armed.promise;
	} catch (error) {
		clearTimeout(deadline);
		socket?.destroy();
		throw error;
	}

	const phase = (name: string) => {
		if (!socket || terminalError) throw terminalError ?? new Error("owned_work_canary_socket_missing");
		writeFrame(socket, {
			v: 1,
			type: "phase",
			nonce: authorization.nonce,
			deliveryId: authorization.deliveryId,
			phase: name,
		});
	};

	return {
		async holdResponse() {
			if (responseWaiting) throw new Error("owned_work_canary_response_reused");
			responseWaiting = true;
			phase("response_waiting");
			await responseRelease.promise;
			phase("response_released");
		},
		async holdWork() {
			if (workWaiting) throw new Error("owned_work_canary_work_reused");
			workWaiting = true;
			phase("work_waiting");
			await workRelease.promise;
			phase("work_released");
		},
		async holdReceipt() {
			if (receiptWaiting) throw new Error("owned_work_canary_receipt_reused");
			receiptWaiting = true;
			phase("receipt_waiting");
			await receiptRelease.promise;
			phase("receipt_released");
		},
		async receiptRejected(error: unknown) {
			if (receiptRejected || !receiptReleased) throw new Error("owned_work_canary_receipt_order");
			if (!(error instanceof Error) || error.message !== "host receipt returned HTTP 409") {
				throw new Error("owned_work_canary_receipt_not_stale");
			}
			receiptRejected = true;
			phase("receipt_rejected");
		},
		async workSettled() {
			if (workSettled || !workReleased || !receiptRejected) throw new Error("owned_work_canary_settlement_order");
			workSettled = true;
			phase("work_settled");
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			clearTimeout(deadline);
			if (socket && !socket.destroyed) {
				if (workSettled) phase("route_settled");
				socket.end();
			}
		},
	};
}
