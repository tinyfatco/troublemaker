import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export async function readRoutingKey(path) {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("routing key must be a regular file, not a link");
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new Error("routing key file must not be accessible by group or other users");
	}
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

function privateValueKey(key, namespace) {
	return createHmac("sha256", key)
		.update("hostd-private-value")
		.update("\0")
		.update(namespace)
		.digest();
}

export function sealPrivateValue(key, namespace, value) {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", privateValueKey(key, namespace), nonce);
	cipher.setAAD(Buffer.from(namespace));
	const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
	return [
		"v1",
		nonce.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		ciphertext.toString("base64url"),
	].join(".");
}

export function openPrivateValue(key, namespace, sealed) {
	const [version, nonce, tag, ciphertext] = String(sealed).split(".");
	if (version !== "v1" || !nonce || !tag || ciphertext === undefined) {
		throw new Error("sealed private value is malformed");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		privateValueKey(key, namespace),
		Buffer.from(nonce, "base64url"),
	);
	decipher.setAAD(Buffer.from(namespace));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf8");
}

export function contextCapability(baseSecret, purpose, contextId) {
	return createHmac("sha256", baseSecret)
		.update(purpose)
		.update("\0")
		.update(contextId)
		.digest("base64url");
}

export function bearerMatches(header, expected) {
	const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
	const actual = Buffer.from(match?.[1] || "");
	const wanted = Buffer.from(expected || "");
	return actual.length === wanted.length && actual.length > 0 && timingSafeEqual(actual, wanted);
}

export function emailAddresses(value) {
	if (typeof value !== "string") return [];
	const matches = value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
	return [...new Set(matches)];
}
