import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	attestOwnedWorkCanaryPhoneHold,
	OWNED_WORK_CANARY_HOLD_META,
} from "../src/owned-work-canary-hold.mjs";

test("Hostd startup attests its exact effective phone hold state and process identity", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hostd-hold-attestation-"));
	try {
		const configPath = join(directory, "config.json");
		const configBytes = Buffer.from('{"phone":{"deliveryHolds":["operator:neutral:intake"]}}\n');
		writeFileSync(configPath, configBytes, { mode: 0o640 });
		const values = new Map();
		const state = {
			config: { phone: { deliveryHolds: ["operator:neutral:intake"] } },
			store: { setMeta: (key, value) => values.set(key, value) },
		};
		const attestation = await attestOwnedWorkCanaryPhoneHold(configPath, state);
		assert.equal(values.size, 1);
		assert.deepEqual(JSON.parse(values.get(OWNED_WORK_CANARY_HOLD_META)), attestation);
		assert.equal(attestation.version, 1);
		assert.equal(attestation.pid, process.pid);
		assert.match(attestation.processStartTicks, /^[1-9]\d*$/);
		assert.equal(attestation.configPath, resolve(configPath));
		assert.equal(attestation.configSha256, createHash("sha256").update(configBytes).digest("hex"));
		assert.deepEqual(attestation.deliveryHolds, ["operator:neutral:intake"]);
		state.config.phone.deliveryHolds.length = 0;
		assert.deepEqual(attestation.deliveryHolds, ["operator:neutral:intake"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Hostd without phone configuration creates no canary hold attestation", async () => {
	let writes = 0;
	const result = await attestOwnedWorkCanaryPhoneHold("/not/read", {
		config: {},
		store: { setMeta: () => { writes += 1; } },
	});
	assert.equal(result, undefined);
	assert.equal(writes, 0);
});
