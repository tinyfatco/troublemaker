import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const agentsTemplate = readFileSync("src/templates/AGENTS.md", "utf8");
const soulTemplate = readFileSync("src/templates/SOUL.md", "utf8");
const hostSeedSource = readFileSync("src/host/node/cli.ts", "utf8");

for (const [name, text] of [
	["AGENTS template", agentsTemplate],
	["embedded AGENTS seed", hostSeedSource],
] as const) {
	assert.match(text, /When a clear instruction or standing authorization exists, act with the capabilities you have\./, `${name} executes clear authorized work`);
	assert.match(text, /execute, verify, and report without asking for approval again/, `${name} avoids repeated approval gates`);
	assert.match(text, /missing presentation or business details are not blockers/, `${name} defers optional review-preview details`);
	assert.match(text, /omitted, represented with unmistakably generic placeholders, or safely deferred/, `${name} gives safe preview fallback choices`);
	assert.match(text, /misrepresentation, unsafe routing, a wrong recipient, a production change, billing, credential handling, or another consequential action/, `${name} preserves consequential fact checks`);
	assert.match(text, /required capability is absent/, `${name} names genuine capability blockers`);
	assert.match(text, /target or scope is materially ambiguous in one of those consequential ways/, `${name} preserves consequential ambiguity checks`);
	assert.match(text, /unapproved hard safety boundary blocks execution/, `${name} preserves hard safety boundaries`);
	assert.doesNotMatch(text, /When in doubt, ask\./, `${name} removes vague approval seeking`);
	assert.doesNotMatch(text, /Anything you're uncertain about/, `${name} removes uncertainty-only approval seeking`);
}

for (const [name, text] of [
	["SOUL template", soulTemplate],
	["embedded SOUL seed", hostSeedSource],
] as const) {
	assert.match(text, /For clear, authorized, reversible work: act, verify, and report without asking again\./, `${name} prefers authorized action`);
	assert.match(text, /required capability is absent/, `${name} limits questions to real blockers`);
	assert.match(text, /unapproved hard safety boundary blocks execution/, `${name} keeps safety boundaries explicit`);
	assert.doesNotMatch(text, /When in doubt, ask before acting externally\./, `${name} removes blanket external approval seeking`);
}

console.log("authorized-execution-guidance ok");
