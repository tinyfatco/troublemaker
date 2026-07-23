import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function importLegacyCheckpoint({ checkpointPath, keyPath, account, store }) {
	if (store.getMeta("gmail:last_successful_poll_at")) {
		throw new Error("host store already has Gmail checkpoint state");
	}
	const encodedKey = (await readFile(keyPath, "utf8")).trim();
	const key = Buffer.from(encodedKey, "base64");
	if (key.length !== 32) throw new Error("legacy checkpoint key is invalid");
	const envelope = JSON.parse(await readFile(checkpointPath, "utf8"));
	if (envelope?.version !== 1) throw new Error("legacy checkpoint version is unsupported");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(envelope.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.ciphertext, "base64")),
		decipher.final(),
	]);
	const state = JSON.parse(plaintext.toString("utf8"));
	if (state?.version !== 1 || state.account !== account || !Array.isArray(state.seenIds)) {
		throw new Error("legacy checkpoint does not match the configured Gmail account");
	}
	store.importSeen("gmail", state.seenIds.filter((id) => typeof id === "string"));
	store.setMeta("gmail:last_successful_poll_at", state.lastSuccessfulPollAt);
	store.setMeta(
		"gmail:pending_read_ids",
		JSON.stringify(
			Array.isArray(state.pendingReadIds)
				? state.pendingReadIds.filter((id) => typeof id === "string")
				: [],
		),
	);
	return {
		seen: state.seenIds.length,
		pendingReads: Array.isArray(state.pendingReadIds) ? state.pendingReadIds.length : 0,
		lastSuccessfulPollAt: state.lastSuccessfulPollAt,
	};
}
