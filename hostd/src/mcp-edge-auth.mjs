import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

export const MCP_EDGE_ASSERTION_HEADERS = Object.freeze({
	version: "x-tinyfat-mcp-version",
	issuer: "x-tinyfat-mcp-issuer",
	audience: "x-tinyfat-mcp-audience",
	timestamp: "x-tinyfat-mcp-timestamp",
	nonce: "x-tinyfat-mcp-nonce",
	signature: "x-tinyfat-mcp-signature",
});

export class McpEdgeAuthError extends Error {
	constructor(message = "invalid MCP edge assertion") {
		super(message);
		this.name = "McpEdgeAuthError";
		this.code = "mcp_edge_unauthorized";
	}
}

export function mcpEdgeBodyDigest(body = Buffer.alloc(0)) {
	return createHash("sha256").update(body).digest("hex");
}

export function mcpEdgeCredentialDigest(authorization = "") {
	return createHash("sha256").update(String(authorization), "utf8").digest("hex");
}

export function mcpEdgeCanonicalRequest({
	version = "1",
	issuer,
	audience,
	timestamp,
	nonce,
	method,
	path,
	bodyDigest,
	credentialDigest,
}) {
	return [
		version,
		issuer,
		audience,
		String(timestamp),
		nonce,
		method.toUpperCase(),
		path,
		bodyDigest,
		credentialDigest,
	].join("\n");
}

export function createMcpEdgeAssertionHeaders({
	secret,
	issuer,
	audience,
	method,
	path,
	body = Buffer.alloc(0),
	authorization = "",
	timestamp = Math.floor(Date.now() / 1000),
	nonce = randomUUID(),
}) {
	const canonical = mcpEdgeCanonicalRequest({
		issuer,
		audience,
		timestamp,
		nonce,
		method,
		path,
		bodyDigest: mcpEdgeBodyDigest(body),
		credentialDigest: mcpEdgeCredentialDigest(authorization),
	});
	return {
		[MCP_EDGE_ASSERTION_HEADERS.version]: "1",
		[MCP_EDGE_ASSERTION_HEADERS.issuer]: issuer,
		[MCP_EDGE_ASSERTION_HEADERS.audience]: audience,
		[MCP_EDGE_ASSERTION_HEADERS.timestamp]: String(timestamp),
		[MCP_EDGE_ASSERTION_HEADERS.nonce]: nonce,
		[MCP_EDGE_ASSERTION_HEADERS.signature]: createHmac("sha256", secret)
			.update(canonical)
			.digest("hex"),
	};
}

function headerValue(headers, name) {
	const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function requiredHeader(headers, name) {
	const value = headerValue(headers, name);
	if (typeof value !== "string" || !value.trim()) throw new McpEdgeAuthError();
	return value.trim();
}

export class McpEdgeAssertionVerifier {
	constructor(config, { now = () => Date.now(), consumeNonce } = {}) {
		this.config = config;
		this.now = now;
		this.consumeNonce = consumeNonce;
		this.usedNonces = new Map();
	}

	verify({ headers, method, path, body = Buffer.alloc(0), allowedIssuers }) {
		const version = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.version);
		const issuer = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.issuer);
		const audience = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.audience);
		const timestampText = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.timestamp);
		const nonce = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.nonce);
		const signature = requiredHeader(headers, MCP_EDGE_ASSERTION_HEADERS.signature);
		const authorization = headerValue(headers, "authorization") || "";
		const acceptedIssuers = allowedIssuers || this.config.issuers;

		if (
			version !== "1"
			|| audience !== this.config.audience
			|| !acceptedIssuers.includes(issuer)
			|| !this.config.issuers.includes(issuer)
		) {
			throw new McpEdgeAuthError();
		}
		if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(issuer)) throw new McpEdgeAuthError();
		if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new McpEdgeAuthError();
		if (!/^\d{10}$/.test(timestampText)) throw new McpEdgeAuthError();
		if (!/^[0-9a-f]{64}$/.test(signature)) throw new McpEdgeAuthError();

		const timestamp = Number(timestampText);
		const nowSeconds = Math.floor(this.now() / 1000);
		if (timestamp > nowSeconds + 5 || nowSeconds - timestamp > this.config.assertionTtlSeconds) {
			throw new McpEdgeAuthError();
		}

		const canonical = mcpEdgeCanonicalRequest({
			version,
			issuer,
			audience,
			timestamp,
			nonce,
			method,
			path,
			bodyDigest: mcpEdgeBodyDigest(body),
			credentialDigest: mcpEdgeCredentialDigest(authorization),
		});
		const assertionSecret = this.config.issuerSecrets?.[issuer];
		if (!assertionSecret) throw new McpEdgeAuthError();
		const expected = Buffer.from(
			createHmac("sha256", assertionSecret).update(canonical).digest("hex"),
			"utf8",
		);
		const supplied = Buffer.from(signature, "utf8");
		if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
			throw new McpEdgeAuthError();
		}

		const expiresAt = timestamp + this.config.assertionTtlSeconds;
		if (this.consumeNonce) {
			if (!this.consumeNonce(issuer, nonce, expiresAt)) throw new McpEdgeAuthError();
		} else {
			this.pruneNonces(nowSeconds);
			const nonceKey = `${issuer}:${nonce}`;
			if (this.usedNonces.has(nonceKey)) throw new McpEdgeAuthError();
			this.usedNonces.set(nonceKey, expiresAt);
		}
		return { issuer };
	}

	pruneNonces(nowSeconds) {
		for (const [nonce, expiresAt] of this.usedNonces) {
			if (expiresAt < nowSeconds) this.usedNonces.delete(nonce);
		}
		if (this.usedNonces.size <= 10_000) return;
		const overflow = this.usedNonces.size - 10_000;
		for (const nonce of [...this.usedNonces.keys()].slice(0, overflow)) {
			this.usedNonces.delete(nonce);
		}
	}
}
