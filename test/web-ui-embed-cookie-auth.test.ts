import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../ui/src/console-api.ts", import.meta.url), "utf8");

assert.doesNotMatch(source, /embed_token|embedToken|EMBED_TOKEN_STORAGE_PREFIX/);
assert.doesNotMatch(source, /sessionStorage\.(?:getItem|setItem)/);
assert.match(source, /window\.location\.pathname\.includes\('\/embed\/agents\/'\)/);
assert.match(source, /const base = isEmbedMode\(\) \? '\/embed\/api\/agents' : '\/api\/v2\/agents'/);
assert.doesNotMatch(source, /if \(isEmbedMode\(\)\) return;/);
assert.match(source, /consoleAgentUrl\('\/messages\/stop'\)/);

console.log("Native Web UI embed cookie-auth and cancellation tests passed");
