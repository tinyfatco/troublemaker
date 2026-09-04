import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import type {
	OwnerPushTransport,
	OwnerPushTransportRequest,
	OwnerPushTransportResult,
} from "../../console/owner-push.js";

export interface AppleOwnerPushTransportOptions {
	teamId: string;
	keyId: string;
	topic: string;
	privateKey: string | Buffer;
	now?: () => Date;
	connect?: (authority: string) => ClientHttp2Session;
	requestTimeoutMs?: number;
}

export type AppleOwnerPushEnvironment = Record<string, string | undefined>;

/** Server-owned APNs token transport. Provider credentials never enter payloads or clients. */
export class AppleOwnerPushTransport implements OwnerPushTransport {
	private readonly privateKey: KeyObject;
	private readonly now: () => Date;
	private readonly connectImplementation: (authority: string) => ClientHttp2Session;
	private readonly requestTimeoutMs: number;
	private cachedAuthorization?: { value: string; issuedAt: number };

	constructor(private readonly options: AppleOwnerPushTransportOptions) {
		if (!/^[A-Z0-9]{10}$/.test(options.teamId)) throw new Error("APNs team id is invalid");
		if (!/^[A-Z0-9]{10}$/.test(options.keyId)) throw new Error("APNs key id is invalid");
		if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(options.topic)) {
			throw new Error("APNs topic is invalid");
		}
		this.privateKey = createPrivateKey(options.privateKey);
		if (this.privateKey.asymmetricKeyType !== "ec"
			|| this.privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
			throw new Error("APNs private key must be a P-256 key");
		}
		this.now = options.now ?? (() => new Date());
		this.connectImplementation = options.connect ?? connect;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
		if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
			throw new Error("APNs request timeout is invalid");
		}
	}

	async send(request: OwnerPushTransportRequest): Promise<OwnerPushTransportResult> {
		if (!/^[a-f0-9]{32,256}$/.test(request.deviceToken)
			|| !/^[A-Za-z0-9._:-]{1,64}$/.test(request.collapseId)) {
			throw new Error("APNs request identity is invalid");
		}
		const body = Buffer.from(JSON.stringify(request.payload), "utf8");
		if (body.byteLength > 4096) throw new Error("APNs payload exceeds 4096 bytes");
		const authority = request.environment === "production"
			? "https://api.push.apple.com"
			: "https://api.sandbox.push.apple.com";
		const session = this.connectImplementation(authority);
		return new Promise<OwnerPushTransportResult>((resolve, reject) => {
			let settled = false;
			let status = 0;
			const response: Buffer[] = [];
			const finish = (result: OwnerPushTransportResult | Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { session.close(); } catch { /* already closed */ }
				if (result instanceof Error) reject(result);
				else resolve(result);
			};
			const timer = setTimeout(() => finish(new Error("APNs request timed out")), this.requestTimeoutMs);
			const stream = session.request({
				":method": "POST",
				":path": `/3/device/${request.deviceToken}`,
				authorization: `bearer ${this.authorization()}`,
				"apns-topic": this.options.topic,
				"apns-push-type": "alert",
				"apns-priority": "10",
				"apns-expiration": "0",
				"apns-collapse-id": request.collapseId,
				"content-type": "application/json",
				"content-length": String(body.byteLength),
			});
			stream.on("response", (headers) => {
				status = Number(headers[":status"] ?? 0);
			});
			stream.on("data", (chunk: Buffer) => {
				if (response.reduce((sum, item) => sum + item.byteLength, 0) + chunk.byteLength <= 16_384) {
					response.push(chunk);
				}
			});
			stream.on("end", () => {
				const reason = safeAPNsReason(Buffer.concat(response));
				const permanentTokenFailure = status === 410
					|| ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reason ?? "");
				finish({
					accepted: status === 200,
					...(permanentTokenFailure ? { permanentTokenFailure: true } : {}),
					...(status ? { status } : {}),
					...(reason ? { reason } : {}),
				});
			});
			stream.on("error", (error) => finish(error));
			session.on("error", (error) => finish(error));
			stream.end(body);
		});
	}

	private authorization(): string {
		const issuedAt = Math.floor(this.now().getTime() / 1_000);
		if (this.cachedAuthorization && issuedAt - this.cachedAuthorization.issuedAt < 50 * 60) {
			return this.cachedAuthorization.value;
		}
		const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.options.keyId }), "utf8")
			.toString("base64url");
		const payload = Buffer.from(JSON.stringify({ iss: this.options.teamId, iat: issuedAt }), "utf8")
			.toString("base64url");
		const signingInput = `${header}.${payload}`;
		const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
			key: this.privateKey,
			dsaEncoding: "ieee-p1363",
		}).toString("base64url");
		const value = `${signingInput}.${signature}`;
		this.cachedAuthorization = { value, issuedAt };
		return value;
	}
}

export function createAppleOwnerPushTransportFromEnvironment(
	env: AppleOwnerPushEnvironment = process.env,
): AppleOwnerPushTransport | undefined {
	const path = env.TROUBLEMAKER_APNS_PRIVATE_KEY_FILE?.trim();
	const teamId = env.TROUBLEMAKER_APNS_TEAM_ID?.trim();
	const keyId = env.TROUBLEMAKER_APNS_KEY_ID?.trim();
	const topic = env.TROUBLEMAKER_APNS_TOPIC?.trim();
	if (!path && !teamId && !keyId && !topic) return undefined;
	if (!path || !teamId || !keyId || !topic) throw new Error("APNs configuration is incomplete");
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
		throw new Error("APNs private key file must be an owner-only regular file");
	}
	return new AppleOwnerPushTransport({
		teamId,
		keyId,
		topic,
		privateKey: readFileSync(path),
	});
}

function safeAPNsReason(bytes: Buffer): string | undefined {
	if (bytes.byteLength === 0) return undefined;
	try {
		const value = JSON.parse(bytes.toString("utf8")) as { reason?: unknown };
		return typeof value.reason === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value.reason)
			? value.reason
			: undefined;
	} catch {
		return undefined;
	}
}
