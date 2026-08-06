import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/host/node/cli.ts", import.meta.url));
const source = readFileSync(cliPath, "utf8");

assert.doesNotMatch(
	source,
	/parsedArgs\.adapters\[i\]/,
	"runtime route registration must not infer configured adapter names from mutable list indexes",
);
assert.match(
	source,
	/const configuredAdapterNames = new Map<AdapterWithHandler, string>\(\)/,
	"configured adapter names must be stored by adapter instance",
);
assert.match(
	source,
	/configuredAdapterNames\.set\(adapter, adapterName\)/,
	"each configured adapter must retain its original CLI name",
);
assert.equal(
	(source.match(/configuredAdapterNames\.get\(adapter\)/g) || []).length,
	2,
	"route registration and readiness must both resolve names by adapter instance",
);

console.log("adapter route registration ok");
