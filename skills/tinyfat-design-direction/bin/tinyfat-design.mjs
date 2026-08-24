#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	loadGrammarLibrary,
	planInterview,
	readJson,
	recordIteration,
	scaffoldSite,
	selectDirection,
	structuralFingerprint,
	validateDesignBrief,
	validateDirection,
	validateProject,
	writeJson,
} from "../lib/design-direction.mjs";

function usage() {
	console.error(`Usage:
  tinyfat-design.mjs grammars
  tinyfat-design.mjs validate-brief --brief FILE
  tinyfat-design.mjs plan-interview --brief FILE
  tinyfat-design.mjs select --brief FILE --out FILE [--grammar ID] [--at ISO_UTC]
  tinyfat-design.mjs scaffold --brief FILE --direction FILE --out DIRECTORY
  tinyfat-design.mjs fingerprint --site FILE
  tinyfat-design.mjs iterate --brief FILE --direction FILE --kind KIND --summary TEXT --evidence ID[,ID...] [--at ISO_UTC]
  tinyfat-design.mjs check --project DIRECTORY [--stage candidate|release]`);
}

function options(values) {
	const result = { _: [] };
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!value.startsWith("--")) {
			result._.push(value);
			continue;
		}
		const key = value.slice(2);
		const next = values[index + 1];
		if (!next || next.startsWith("--")) result[key] = true;
		else {
			result[key] = next;
			index += 1;
		}
	}
	return result;
}

function required(args, key) {
	if (typeof args[key] !== "string" || !args[key]) throw new Error(`--${key} is required`);
	return args[key];
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
	const command = process.argv[2];
	const args = options(process.argv.slice(3));
	if (!command || command === "help" || command === "--help") {
		usage();
		return;
	}
	if (command === "grammars") {
		print(loadGrammarLibrary());
		return;
	}
	if (command === "validate-brief") {
		print({ ok: true, brief: validateDesignBrief(readJson(required(args, "brief"))) });
		return;
	}
	if (command === "plan-interview") {
		print(planInterview(readJson(required(args, "brief"))));
		return;
	}
	if (command === "select") {
		const direction = selectDirection(readJson(required(args, "brief")), {
			grammarId: typeof args.grammar === "string" ? args.grammar : undefined,
			selectedAt: typeof args.at === "string" ? args.at : undefined,
		});
		writeJson(resolve(required(args, "out")), direction);
		print({ ok: true, grammar: direction.grammar, output: resolve(args.out) });
		return;
	}
	if (command === "scaffold") {
		const brief = readJson(required(args, "brief"));
		const direction = readJson(required(args, "direction"));
		validateDirection(direction, brief);
		const output = resolve(required(args, "out"));
		mkdirSync(output, { recursive: true });
		writeFileSync(join(output, "index.html"), scaffoldSite(brief, direction), { mode: 0o600 });
		print({ ok: true, output: join(output, "index.html"), grammar: direction.grammar });
		return;
	}
	if (command === "fingerprint") {
		print(structuralFingerprint(readFileSync(required(args, "site"), "utf8")));
		return;
	}
	if (command === "iterate") {
		const brief = readJson(required(args, "brief"));
		const directionPath = resolve(required(args, "direction"));
		const next = recordIteration(readJson(directionPath), brief, {
			kind: required(args, "kind"),
			summary: required(args, "summary"),
			evidenceRefs: required(args, "evidence").split(",").map((entry) => entry.trim()).filter(Boolean),
			at: typeof args.at === "string" ? args.at : undefined,
		});
		writeJson(directionPath, next);
		print({ ok: true, sequence: next.iteration_history.length, output: directionPath });
		return;
	}
	if (command === "check") {
		print(validateProject(required(args, "project"), {
			stage: typeof args.stage === "string" ? args.stage : "candidate",
		}));
		return;
	}
	throw new Error(`Unknown command ${command}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
