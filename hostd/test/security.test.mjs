import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRoutingKey } from "../src/security.mjs";

test("routing keys require a private regular file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-routing-key-"));
	const keyPath = join(directory, "routing.key");
	const linkPath = join(directory, "routing-link.key");
	try {
		await writeFile(keyPath, `${Buffer.alloc(32, 7).toString("base64")}\n`, { mode: 0o600 });
		assert.deepEqual(await readRoutingKey(keyPath), Buffer.alloc(32, 7));

		await chmod(keyPath, 0o644);
		await assert.rejects(readRoutingKey(keyPath), /group or other users/);

		await chmod(keyPath, 0o600);
		await symlink(keyPath, linkPath);
		await assert.rejects(readRoutingKey(linkPath), /regular file/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
