import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const runner = await readFile("scripts/run-local-mac.sh", "utf8");
const installer = await readFile("scripts/install-ghost-mac.sh", "utf8");
const cli = await readFile("src/host/node/cli.ts", "utf8");

for (const script of ["scripts/run-local-mac.sh", "scripts/install-ghost-mac.sh"]) {
	const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
}

assert.match(runner, /TROUBLEMAKER_ENV_FILE/);
assert.match(runner, /--adapter="\$ADAPTERS"/);
assert.match(runner, /TROUBLEMAKER_HOST:-127\.0\.0\.1/);
assert.match(runner, /--host="\$HOST"/);
assert.match(installer, /web,mcp,slack:socket,telegram:polling/);
assert.match(installer, /TROUBLEMAKER_HOST string 127\.0\.0\.1/);
assert.match(installer, /127\.0\.0\.1:\$RELAY_PORT:127\.0\.0\.1:\$PORT/);
assert.match(installer, /ExitOnForwardFailure=yes/);
assert.doesNotMatch(installer, /0\.0\.0\.0/);
assert.match(cli, /earlyWsServer\.listen\(8765, parsedArgs\.host,/);
assert.match(cli, /webVoiceServer\.listen\(8766, parsedArgs\.host,/);
