import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readProtectedTokenFile } from "../src/protected-token-file.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
	if (condition) { passed++; console.log(`  ✓ ${message}`); }
	else { failed++; console.error(`  ✗ ${message}`); }
}
function throws(fn: () => unknown, pattern: RegExp): boolean {
	try { fn(); return false; }
	catch (error) { return pattern.test(error instanceof Error ? error.message : String(error)); }
}

const dir = mkdtempSync(join(tmpdir(), "protected-token-"));
try {
	const secure = join(dir, "secure");
	writeFileSync(secure, "  secret-value  \n", { mode: 0o600 });
	assert(readProtectedTokenFile(secure) === "secret-value", "reads and trims a private owner token file");
	assert(readProtectedTokenFile(undefined) === undefined, "an unset token file remains optional");
	assert(throws(() => readProtectedTokenFile("relative-token"), /must be absolute/), "rejects relative token paths");
	const linked = join(dir, "linked");
	symlinkSync(secure, linked);
	assert(throws(() => readProtectedTokenFile(linked), /symbolic link/), "rejects symbolic-link token paths");

	const broad = join(dir, "broad");
	writeFileSync(broad, "secret", { mode: 0o600 });
	chmodSync(broad, 0o640);
	assert(throws(() => readProtectedTokenFile(broad), /group or others/), "rejects group-readable token files");

	const empty = join(dir, "empty");
	writeFileSync(empty, "\n", { mode: 0o600 });
	assert(throws(() => readProtectedTokenFile(empty), /empty/), "rejects empty token files");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
