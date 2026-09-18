import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";

const MAXIMUM_SOURCE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

export class ScopedAppEvidenceError extends Error {
	constructor(code = "evidence_unavailable", status = 503) {
		super(code);
		this.name = "ScopedAppEvidenceError";
		this.code = code;
		this.status = status;
	}
}

function reject(code = "evidence_unavailable", status = 503) {
	throw new ScopedAppEvidenceError(code, status);
}

function publicSourceUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		reject("invalid_source", 400);
	}
	if (
		url.protocol !== "https:"
		|| url.username
		|| url.password
		|| url.port
		|| isIP(url.hostname.replace(/^\[|\]$/g, ""))
		|| !url.hostname.includes(".")
		|| /\.(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)
	) reject("invalid_source", 400);
	return url;
}

function publicIpv4(address) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b, c] = parts;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false;
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

function publicIpv6(address) {
	const normalized = address.toLowerCase().split("%", 1)[0];
	if (normalized === "::" || normalized === "::1") return false;
	if (/^(?:fc|fd|fe[89ab]|ff)/.test(normalized)) return false;
	if (normalized.startsWith("2001:db8:")) return false;
	const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return publicIpv4(mapped[1]);
	return true;
}

function publicAddress(address, family) {
	return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

async function resolvedPublicAddresses(hostname) {
	let addresses;
	try {
		addresses = await dnsLookup(hostname, { all: true, verbatim: true });
	} catch {
		reject();
	}
	if (!addresses.length || addresses.some(({ address, family }) => !publicAddress(address, family))) reject();
	return addresses;
}

function guardedLookup(hostname, options, callback) {
	void resolvedPublicAddresses(hostname).then((addresses) => {
		const family = typeof options === "number" ? options : options?.family;
		const eligible = family === 4 || family === 6
			? addresses.filter((address) => address.family === family)
			: addresses;
		if (!eligible.length) throw new ScopedAppEvidenceError();
		if (typeof options === "object" && options?.all) callback(null, eligible);
		else callback(null, eligible[0].address, eligible[0].family);
	}).catch((error) => callback(error));
}

async function oneRequest(url) {
	await resolvedPublicAddresses(url.hostname);
	return await new Promise((resolvePromise, rejectPromise) => {
		const request = httpsRequest(url, {
			method: "GET",
			agent: false,
			lookup: guardedLookup,
			headers: {
				accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
				"accept-encoding": "identity",
				"user-agent": "TinyFat-Source-Evidence/1.0",
			},
		}, (response) => {
			response.on("error", rejectPromise);
			const chunks = [];
			let length = 0;
			const declared = response.headers["content-length"];
			if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_SOURCE_BYTES)) {
				response.destroy(new ScopedAppEvidenceError("source_too_large", 400));
				return;
			}
			if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
				response.destroy(new ScopedAppEvidenceError("unsupported_source_encoding", 400));
				return;
			}
			response.on("data", (chunk) => {
				length += chunk.length;
				if (length > MAXIMUM_SOURCE_BYTES) {
					response.destroy(new ScopedAppEvidenceError("source_too_large", 400));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolvePromise({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks),
			}));
		});
		request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new ScopedAppEvidenceError()));
		request.on("error", rejectPromise);
		request.end();
	});
}

function normalizedVisibleText(value) {
	return value.replace(/\s+/g, " ").trim();
}

export async function fetchScopedEvidenceSource(rawUrl, exactQuote) {
	let url = publicSourceUrl(rawUrl);
	for (let redirect = 0; redirect <= MAXIMUM_REDIRECTS; redirect += 1) {
		let response;
		try {
			response = await oneRequest(url);
		} catch (error) {
			if (error instanceof ScopedAppEvidenceError) throw error;
			reject();
		}
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			if (redirect === MAXIMUM_REDIRECTS || typeof response.headers.location !== "string") reject();
			url = publicSourceUrl(new URL(response.headers.location, url).toString());
			continue;
		}
		if (response.status < 200 || response.status >= 300 || response.body.length === 0) reject();
		const mediaType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
		if (!(
			mediaType.startsWith("text/")
			|| mediaType === "application/json"
			|| mediaType === "application/xhtml+xml"
			|| mediaType === "application/xml"
		)) reject("unsupported_source_type", 400);
		const decoded = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
		let visible = decoded;
		if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
			visible = new JSDOM(decoded).window.document.body?.textContent ?? "";
		}
		if (
			!decoded.includes(exactQuote)
			&& !visible.includes(exactQuote)
			&& !normalizedVisibleText(visible).includes(normalizedVisibleText(exactQuote))
		) reject("quote_not_found", 400);
		return {
			sourceUrl: url.toString(),
			sourceSha256: createHash("sha256").update(response.body).digest("hex"),
		};
	}
	reject();
}

export class ScopedAppEvidence {
	constructor({ runtime, target, fetchSource = fetchScopedEvidenceSource }) {
		this.runtime = runtime;
		this.target = target;
		this.fetchSource = fetchSource;
		this.available = target?.computer?.enabled === true && typeof runtime?.captureScopedEvidence === "function";
	}

	async verifySource(payload) {
		if (!this.available) reject();
		return await this.fetchSource(payload.sourceUrl, payload.exactQuote);
	}

	async capture(contextId, input) {
		if (!this.available) reject();
		const captured = await this.runtime.captureScopedEvidence(this.target, contextId, input);
		if (!captured?.receipt || !captured?.artifact) reject();
		return {
			...captured,
			receipt: {
				...captured.receipt,
				representation: "derived_quote_rendering",
				originalSourceScreenshot: false,
			},
		};
	}
}
