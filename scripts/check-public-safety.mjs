#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
	.split("\0")
	.filter(Boolean);
const errors = [];

const blockedPathPatterns = [
	/^memory-bank\//,
	/^memory\//,
	/^scratch\//,
	/(^|\/)\.env($|\.)/,
	/(^|\/)(?:auth|credentials)\.json$/i,
	/\.(?:pem|key|p12|pfx|sqlite3?|db|jsonl|log)$/i,
];

for (const file of files) {
	if (file !== ".env.example" && blockedPathPatterns.some((pattern) => pattern.test(file))) {
		errors.push(`${file}: private/runtime path must not be tracked`);
		continue;
	}
	if (file === "scripts/check-public-safety.mjs" || file.endsWith("package-lock.json")) continue;

	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}

	for (const [index, line] of text.split("\n").entries()) {
		const location = `${file}:${index + 1}`;
		if (/github\.com\/notifications\/unsubscribe-auth\//i.test(line)) {
			errors.push(`${location}: signed unsubscribe URL`);
		}
		if (/repository_invitations\/\d+/i.test(line)) {
			errors.push(`${location}: repository invitation identifier`);
		}
		if (/\/(?:Users|home)\/(?!example(?:\/|$))[A-Za-z0-9._-]+/.test(line)) {
			errors.push(`${location}: host-specific home path`);
		}
		for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
			const address = match[0].toLowerCase();
			const domain = match[1].toLowerCase();
			if (address.endsWith("@2x.png")) continue;
			if (domain === "example.com" || domain.endsWith(".example.com") || domain === "users.noreply.github.com") continue;
			errors.push(`${location}: non-example email address (${domain})`);
		}
		if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/.test(line)) {
			errors.push(`${location}: private key material`);
		}
		if (/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|xapp-|sk-ant-(?:api03-)?|sk-(?:proj-)?|AIza|AKIA|ASIA|npm_|pypi-|SG\.)[A-Za-z0-9_.-]{12,}\b/.test(line)
			&& !/(?:\.\.\.|placeholder|example|your-token)/i.test(line)) {
			errors.push(`${location}: credential-shaped value`);
		}
	}
}

if (errors.length > 0) {
	console.error("Public-safety check failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
	process.exit(1);
}

console.log(`Public-safety check passed (${files.length} tracked files).`);
