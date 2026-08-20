import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const text = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(text(path));

test("the repository uses one pinned PNPM workspace lock", () => {
	const root = json("package.json");
	assert.equal(root.packageManager, "pnpm@10.15.1");
	assert.equal(existsSync(new URL("../pnpm-lock.yaml", import.meta.url)), true);
	assert.equal(existsSync(new URL("../package-lock.json", import.meta.url)), false);
	assert.equal(existsSync(new URL("../ui/package-lock.json", import.meta.url)), false);

	const workspace = text("pnpm-workspace.yaml");
	for (const packagePath of [".", "agent", "hostd", "ui"]) {
		assert.match(workspace, new RegExp(`^\\s*- ${packagePath.replace(".", "\\.")}$`, "m"));
	}
});

test("scripts and guarded build paths use PNPM deterministically", () => {
	const scripts = Object.values(json("package.json").scripts).join("\n");
	assert.doesNotMatch(scripts, /\bnpm run\b|\bnpx\b/);

	const workflow = text(".github/workflows/public-safety.yml");
	assert.match(workflow, /pnpm\/action-setup@v4/);
	assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.doesNotMatch(workflow, /cache: npm|npm ci/);

	for (const path of ["Dockerfile", "hostd/Containerfile.runtime"]) {
		const container = text(path);
		assert.match(container, /pnpm@10\.15\.1/);
		assert.match(container, /pnpm install --[^\n]*frozen-lockfile/);
		assert.doesNotMatch(container, /COPY package\.json package-lock\.json|npm ci/);
	}
	assert.match(text("hostd/Containerfile.runtime"), /pnpm-lock\.yaml/);
});
