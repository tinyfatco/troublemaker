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
			["192.168.0.0", 16],
			["198.18.0.0", 15],
			["198.51.100.0", 24],
			["203.0.113.0", 24],
			["224.0.0.0", 4],
		].some(([base, bits]) => inIpv4Range(value, base, bits));
	}
	if (family !== 6) return false;
	if (
		address === "::"
		|| address === "::1"
		|| address.startsWith("::")
		|| address.startsWith("fc")
		|| address.startsWith("fd")
		|| /^fe[89abcdef]/.test(address)
		|| address.startsWith("ff")
		|| address.startsWith("2001:db8:")
	) return false;
	return true;
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
					response.writeHead(
						upstreamResponse.statusCode || 502,
						responseHeaders(upstreamResponse.headers),
					);
					upstreamResponse.on("error", reject);
					upstreamResponse.on("end", resolvePromise);
					upstreamResponse.pipe(response);
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
