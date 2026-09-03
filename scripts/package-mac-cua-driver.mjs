#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VERSION = "0.20.0";
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
	console.error("usage: package-mac-cua-driver.mjs <source executable> <bundle destination>");
	process.exit(2);
}
const source = resolve(sourceArg);
const destination = resolve(destinationArg);
const manifest = `${destination}.manifest.json`;
const temporaryDir = `${destination}.stage-${process.pid}`;
const temporary = join(temporaryDir, "cua-driver");
const temporaryManifest = join(temporaryDir, "cua-driver.manifest.json");
const rollback = `${destination}.rollback-${process.pid}`;
const rollbackManifest = `${manifest}.rollback-${process.pid}`;
const trustPath = new URL("../packaging/cua-driver-artifacts.json", import.meta.url);
const trust = JSON.parse(readFileSync(trustPath, "utf8"));
const trusted = trust.artifacts?.find((entry) => entry.version === VERSION && entry.platform === "darwin-universal");
if (!trusted) throw new Error(`No reviewed Cua Driver artifact provenance for ${VERSION}`);

if (sourceArg === "--finalize") {
	const packaged = resolve(destinationArg);
	const packagedManifest = `${packaged}.manifest.json`;
	const current = JSON.parse(readFileSync(packagedManifest, "utf8"));
	const next = `${packagedManifest}.next-${process.pid}`;
	current.sha256 = createHash("sha256").update(readFileSync(packaged)).digest("hex");
	writeFileSync(next, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
	renameSync(next, packagedManifest);
	console.log(`Finalized packaged Cua Driver ${VERSION} integrity (${current.sha256})`);
	process.exit(0);
}

function verifyExecutable(path) {
	if (!existsSync(path)) throw new Error(`Cua Driver executable is absent: ${path}`);
	const sourceStat = lstatSync(path);
	if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error(`Cua Driver input must be a regular non-symlink file: ${path}`);
	const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0 || result.stdout.trim() !== `cua-driver ${VERSION}`) {
		throw new Error(`Cua Driver ${VERSION} is required; refusing ${basename(path)}`);
	}
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (sha256 !== trusted.sha256) throw new Error("Cua Driver source digest is not in the reviewed artifact allowlist");
	const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
	const details = `${signature.stdout}\n${signature.stderr}`;
	if (signature.status !== 0 || !details.includes(`Identifier=${trusted.identifier}`) || !details.includes(`TeamIdentifier=${trusted.teamIdentifier}`) || !details.includes(`Authority=${trusted.authority}`)) {
		throw new Error("Cua Driver source does not match the reviewed upstream Developer ID provenance");
	}
}

function verifyCopiedBytes(path) {
	const copied = lstatSync(path);
	if (copied.isSymbolicLink() || !copied.isFile()) throw new Error("Packaged Cua Driver must be a regular file");
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (sha256 !== trusted.sha256) throw new Error("Copied Cua Driver bytes changed before bundle signing");
}

try {
	verifyExecutable(source);
	mkdirSync(dirname(destination), { recursive: true });
	mkdirSync(temporaryDir, { recursive: false });
	copyFileSync(source, temporary);
	chmodSync(temporary, 0o755);
	verifyCopiedBytes(temporary);
	const sha256 = createHash("sha256").update(readFileSync(temporary)).digest("hex");
	writeFileSync(temporaryManifest, `${JSON.stringify({ format: 1, component: "@trycua/cua-driver-executable", version: VERSION, sourceSha256: trusted.sha256, sha256, hostBundleId: trust.hostBundleId }, null, 2)}\n`, { mode: 0o644 });
	// Commit only after both staged artifacts validate; retain paired last-good bytes until both renames finish.
	if (existsSync(destination)) renameSync(destination, rollback);
	if (existsSync(manifest)) renameSync(manifest, rollbackManifest);
	try {
		renameSync(temporary, destination);
		renameSync(temporaryManifest, manifest);
	} catch (error) {
		rmSync(destination, { force: true });
		rmSync(manifest, { force: true });
		if (existsSync(rollback)) renameSync(rollback, destination);
		if (existsSync(rollbackManifest)) renameSync(rollbackManifest, manifest);
		throw error;
	}
	rmSync(rollback, { force: true });
	rmSync(rollbackManifest, { force: true });
	rmSync(temporaryDir, { recursive: true, force: true });
	console.log(`Packaged pinned Cua Driver ${VERSION} (${sha256})`);
} catch (error) {
	rmSync(temporary, { force: true });
	rmSync(temporaryManifest, { force: true });
	rmSync(temporaryDir, { recursive: true, force: true });
	if (!existsSync(destination) && existsSync(rollback)) renameSync(rollback, destination);
	if (!existsSync(manifest) && existsSync(rollbackManifest)) renameSync(rollbackManifest, manifest);
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
