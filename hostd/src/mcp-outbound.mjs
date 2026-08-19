import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { HostMcpError, normalizeMcpServerUrl } from "./mcp.mjs";

function ipv4Number(address) {
	return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inIpv4Range(value, base, bits) {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (ipv4Number(base) & mask);
}

function ipv6Number(address) {
	let normalized = address.toLowerCase();
	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		const ipv4 = normalized.slice(lastColon + 1);
		if (isIP(ipv4) !== 4) return null;
		const value = ipv4Number(ipv4);
		normalized = `${normalized.slice(0, lastColon)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
	}
	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
	const parts = [...left, ...Array(missing).fill("0"), ...right];
	if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
	return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function inIpv6Range(value, base, bits) {
	const baseValue = ipv6Number(base);
	if (value === null || baseValue === null) return false;
	const shift = 128n - BigInt(bits);
	return (value >> shift) === (baseValue >> shift);
}

export function isPublicMcpAddress(rawAddress) {
	const address = String(rawAddress).replace(/^\[|\]$/g, "").toLowerCase();
	const family = isIP(address);
	if (family === 4) {
		const value = ipv4Number(address);
		return ![
			["0.0.0.0", 8],
			["10.0.0.0", 8],
			["100.64.0.0", 10],
			["127.0.0.0", 8],
			["169.254.0.0", 16],
			["172.16.0.0", 12],
			["192.0.0.0", 24],
			["192.0.2.0", 24],
			["192.88.99.0", 24],
			["192.168.0.0", 16],
			["198.18.0.0", 15],
			["198.51.100.0", 24],
			["203.0.113.0", 24],
			["224.0.0.0", 4],
			["240.0.0.0", 4],
		].some(([base, bits]) => inIpv4Range(value, base, bits));
	}
	if (family !== 6) return false;
	const value = ipv6Number(address);
	if (!inIpv6Range(value, "2000::", 3)) return false;
	return ![
		["2001::", 23],
		["2001:db8::", 32],
		["2002::", 16],
		["3fff::", 20],
	].some(([base, bits]) => inIpv6Range(value, base, bits));
}

export async function resolvePublicMcpDestination(rawUrl, lookup = dnsLookup) {
	const normalized = normalizeMcpServerUrl(rawUrl);
	const url = new URL(normalized);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (/^(?:localhost|.+\.localhost|.+\.local|.+\.internal)$/i.test(hostname)) {
		throw new HostMcpError("mcp_upstream_address_denied", 403);
	}
	const directFamily = isIP(hostname);
	const candidates = directFamily
		? [{ address: hostname, family: directFamily }]
		: await lookup(hostname, { all: true, verbatim: true });
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new HostMcpError("mcp_upstream_unavailable", 502);
	}
	const destination = candidates.find((candidate) => isPublicMcpAddress(candidate.address));
	if (!destination || candidates.some((candidate) => !isPublicMcpAddress(candidate.address))) {
		throw new HostMcpError("mcp_upstream_address_denied", 403);
	}
	return { url, address: destination.address, family: destination.family };
}

async function readBody(request, maximumBytes) {
	if (["GET", "HEAD", "DELETE"].includes(request.method || "")) return Buffer.alloc(0);
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new HostMcpError("request_too_large", 413);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function forwardedRequestHeaders(request, connection, credential, body) {
	const headers = {
		accept: request.headers.accept || "application/json, text/event-stream",
		"user-agent": "TinyFat-Hostd-MCP/1.0",
	};
	if (body.length > 0) {
		headers["content-type"] = request.headers["content-type"] || "application/json";
		headers["content-length"] = String(body.length);
	}
	for (const name of ["mcp-protocol-version", "mcp-session-id", "last-event-id"]) {
		if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
	}
	if (connection.authType === "bearer") headers.authorization = `Bearer ${credential}`;
	if (connection.authType === "header") headers[connection.headerName] = credential;
	return headers;
}

function responseHeaders(upstreamHeaders) {
	const headers = {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	};
	for (const name of [
		"content-type",
		"mcp-session-id",
		"retry-after",
		"www-authenticate",
	]) {
		const value = upstreamHeaders[name];
		if (typeof value === "string" || Array.isArray(value)) headers[name] = value;
	}
	return headers;
}

export class HostMcpOutboundProxy {
	constructor({ config, store, mcp, lookup = dnsLookup } = {}) {
		this.config = config;
		this.store = store;
		this.mcp = mcp;
		this.lookup = lookup;
	}

	async proxy(request, response, contextId, connectionId) {
		if (!["POST", "GET", "DELETE"].includes(request.method || "")) {
			throw new HostMcpError("method_not_allowed", 405);
		}
		const connection = this.store.getMcpOutboundConnection(contextId, connectionId);
		if (!connection || connection.status !== "active") {
			throw new HostMcpError("connection_not_found", 404);
		}
		this.mcp.assertOutboundConnection(connection);
		const destination = await resolvePublicMcpDestination(connection.upstreamUrl, this.lookup);
		const credential = this.mcp.openOutboundCredential(connection);
		if (connection.authType !== "none" && !credential) {
			throw new HostMcpError("mcp_upstream_credential_unavailable", 503);
		}
		const body = await readBody(request, this.config.mcp.maximumRequestBytes);
		try {
			await new Promise((resolvePromise, reject) => {
				const upstream = httpsRequest(destination.url, {
					method: request.method,
					headers: forwardedRequestHeaders(request, connection, credential, body),
					servername: isIP(destination.url.hostname.replace(/^\[|\]$/g, ""))
						? undefined
						: destination.url.hostname,
					lookup: (_hostname, _options, callback) => {
						callback(null, destination.address, destination.family);
					},
					timeout: 180_000,
				}, (upstreamResponse) => {
					const rawDeclaredLength = upstreamResponse.headers["content-length"];
					const declaredLength = typeof rawDeclaredLength === "string" && /^\d+$/.test(rawDeclaredLength)
						? Number(rawDeclaredLength)
						: undefined;
					if (
						(rawDeclaredLength !== undefined && declaredLength === undefined)
						|| (declaredLength !== undefined && declaredLength > this.config.mcp.maximumResponseBytes)
					) {
						upstreamResponse.resume();
						reject(new HostMcpError("mcp_upstream_response_too_large", 502));
						return;
					}
					response.writeHead(
						upstreamResponse.statusCode || 502,
						responseHeaders(upstreamResponse.headers),
					);
					let received = 0;
					let failed = false;
					upstreamResponse.on("data", (chunk) => {
						received += chunk.length;
						if (received > this.config.mcp.maximumResponseBytes) {
							failed = true;
							const error = new HostMcpError("mcp_upstream_response_too_large", 502);
							upstreamResponse.destroy();
							response.destroy(error);
							reject(error);
							return;
						}
						if (!response.write(chunk)) {
							upstreamResponse.pause();
							response.once("drain", () => upstreamResponse.resume());
						}
					});
					upstreamResponse.on("error", (error) => {
						if (!failed) reject(error);
					});
					upstreamResponse.on("end", () => {
						if (failed) return;
						response.end();
						resolvePromise();
					});
				});
				upstream.on("timeout", () => upstream.destroy(new Error("MCP upstream timed out")));
				upstream.on("error", reject);
				request.once("aborted", () => upstream.destroy(new Error("MCP client disconnected")));
				if (body.length > 0) upstream.write(body);
				upstream.end();
			});
			this.store.touchMcpOutboundConnection(contextId, connectionId);
		} catch (error) {
			this.store.touchMcpOutboundConnection(contextId, connectionId, error);
			throw error;
		}
	}
}
