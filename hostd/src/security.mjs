import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function readRoutingKey(path) {
	const encoded = (await readFile(path, "utf8")).trim();
	const key = Buffer.from(encoded, "base64");
	if (key.length !== 32) throw new Error("routing key must be 32 bytes encoded as base64");
	return key;
}

export function stablePrivateKey(key, namespace, value) {
	return createHmac("sha256", key)
		.update(namespace)
		.update("\0")
		.update(value.trim().toLowerCase())
		.digest("hex");
}

export function contextCapability(baseSecret, purpose, contextId) {
	return createHmac("sha256", baseSecret)
		.update(purpose)
		.update("\0")
		.update(contextId)
		.digest("base64url");
}

export function bearerMatches(header, expected) {
	const actual = Buffer.from(typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : "");
	const wanted = Buffer.from(expected || "");
	return actual.length === wanted.length && actual.length > 0 && timingSafeEqual(actual, wanted);
}

export function emailAddresses(value) {
	if (typeof value !== "string") return [];
	const matches = value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
	return [...new Set(matches)];
}
