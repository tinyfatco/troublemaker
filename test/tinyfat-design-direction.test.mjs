import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DESIGN_BRIEF_SCHEMA,
	DESIGN_REVIEW_SCHEMA,
	fingerprintSimilarity,
	loadGrammarLibrary,
	planInterview,
	recordIteration,
	scaffoldSite,
	selectDirection,
	sha256,
	structuralFingerprint,
	validateDesignBrief,
	validateDirection,
	validateProject,
	validateSiteSource,
	writeJson,
} from "../skills/tinyfat-design-direction/lib/design-direction.mjs";

const NOW = "2026-08-24T20:00:00.000Z";

const fixtures = [
	["editorial-ledger", "professional-service", ["Tax planning", "Bookkeeping", "Filing support"], ["credible", "precise"]],
	["guided-care-path", "counseling", ["In-person sessions", "Remote sessions", "Guided resources"], ["reassuring", "private"]],
	["trade-dispatch", "local-trade", ["Repair", "Installation", "Maintenance"], ["direct", "local"]],
	["portfolio-canvas", "creative-practice", ["Portraits", "Editorial work", "Studio commissions"], ["visual", "crafted"]],
	["catalog-workbench", "product-catalog", ["Small batch one", "Small batch two", "Seasonal release"], ["tactile", "organized"]],
	["community-bulletin", "community", ["Gatherings", "Workshops", "Volunteer days"], ["neighborly", "informative"]],
];

function briefFor(grammarId, shape, offerings, qualities, overrides = {}) {
	const source = {
		schema_version: DESIGN_BRIEF_SCHEMA,
		project: { slug: `example-${grammarId}`, name: `Example ${grammarId.replaceAll("-", " ")}` },
		business: {
			name: "Example Business",
			shape,
			audiences: ["people seeking a clear next step"],
			offerings,
			primary_actions: ["Request a conversation"],
		},
		evidence: [
			{ id: "source-1", type: "owner-brief", source: "synthetic owner brief", fact: `The business shape is ${shape}.`, observed_at: NOW },
			{ id: "source-2", type: "interview", source: "synthetic interview", fact: `Desired qualities are ${qualities.join(", ")}.`, observed_at: NOW },
		],
		desired_qualities: qualities,
		avoided_qualities: ["generic", "cookie-cutter"],
		references: [],
		existing_site: { status: "none", url: null, evidence_ids: [] },
		optional_open_questions: ["Final imagery may be supplied later."],
		assumptions: [{ statement: "The first preview may use a content-first composition.", evidence_ids: ["source-1"], confidence: "medium" }],
		provenance: { created_at: NOW, created_by: "synthetic-test", source_refs: ["fixture:synthetic"] },
	};
	return {
		...source,
		...overrides,
		project: { ...source.project, ...(overrides.project || {}) },
		business: { ...source.business, ...(overrides.business || {}) },
		existing_site: { ...source.existing_site, ...(overrides.existing_site || {}) },
		provenance: { ...source.provenance, ...(overrides.provenance || {}) },
	};
}

test("library exposes six materially different executable grammars", () => {
	const library = loadGrammarLibrary();
	assert.equal(library.grammars.length, 6);
	assert.equal(new Set(library.grammars.map((grammar) => grammar.id)).size, 6);
	for (const grammar of library.grammars) {
		assert.ok(grammar.required_sections.length >= 5);
		assert.ok(grammar.prohibited_defaults.includes("centered-hero"));
	}
});

test("synthetic briefs select, scaffold, and validate materially distinct structures", () => {
	const outputs = fixtures.map(([grammarId, shape, offerings, qualities]) => {
		const brief = briefFor(grammarId, shape, offerings, qualities);
		validateDesignBrief(brief);
		const direction = selectDirection(brief, { grammarId, selectedAt: NOW });
		validateDirection(direction, brief);
		const source = scaffoldSite(brief, direction);
		const result = validateSiteSource(source, direction, brief);
		assert.equal(result.grammar, grammarId);
		return { grammarId, source, fingerprint: result.fingerprint };
	});
	for (let left = 0; left < outputs.length; left += 1) {
		for (let right = left + 1; right < outputs.length; right += 1) {
			const score = fingerprintSimilarity(outputs[left].fingerprint, outputs[right].fingerprint);
			assert.ok(score < 0.58, `${outputs[left].grammarId} and ${outputs[right].grammarId} are too similar: ${score}`);
		}
	}
});

test("direction selection uses business evidence and optional details do not block care preview", () => {
	const care = briefFor("guided-care-path", "counseling", ["In-person care", "Remote care", "Resources"], ["reassuring", "private"], {
		optional_open_questions: ["Exact office location", "Final calendar link", "Customer photography"],
	});
	const plan = planInterview(care);
	assert.equal(plan.acknowledge_before_question, true);
	assert.equal(plan.focused_question, null);
	assert.equal(plan.may_proceed, true);
	assert.equal(plan.optional_questions_are_non_blocking, true);
	assert.equal(selectDirection(care, { selectedAt: NOW }).grammar.id, "guided-care-path");
});

test("unknown primary purpose yields one focused internal question plan", () => {
	const unknown = briefFor("unknown", "unknown", ["A possible service"], ["credible"], {
		evidence: [{ id: "source-1", type: "customer-message", source: "synthetic inbound", fact: "Please make a website.", observed_at: NOW }],
		assumptions: [{ statement: "The primary purpose is not yet known.", evidence_ids: ["source-1"], confidence: "low" }],
	});
	const plan = planInterview(unknown);
	assert.equal(plan.focused_question.topic, "primary-purpose");
	assert.equal(plan.may_proceed, true, "known offering allows bounded progress even while purpose is clarified");
	assert.throws(() => selectDirection(unknown, { selectedAt: NOW }), /ambiguous/i);
});

test("anti-default validation rejects a centered hero and pill regression", () => {
	const brief = briefFor(...fixtures[0]);
	const direction = selectDirection(brief, { grammarId: "editorial-ledger", selectedAt: NOW });
	const source = scaffoldSite(brief, direction).replace("</style>", ".hero{text-align:center}.pill{border-radius:999px}</style>").replace("<main class=\"ledger\">", "<main class=\"ledger hero pill\">");
	assert.throws(() => validateSiteSource(source, direction, brief), /prohibited default centered-hero/);
});

test("direction constraints cannot drift and iteration history is append-only", () => {
	const brief = briefFor(...fixtures[2]);
	const direction = selectDirection(brief, { grammarId: "trade-dispatch", selectedAt: NOW });
	const changed = structuredClone(direction);
	changed.constraints.layout_topology = "Generic centered hero";
	assert.throws(() => validateDirection(changed, brief), /layout_topology drifted/);
	const iterated = recordIteration(direction, brief, {
		kind: "customer-feedback",
		summary: "Use quieter work imagery while retaining the dispatch board.",
		evidenceRefs: ["source-2"],
		at: "2026-08-24T20:05:00.000Z",
	});
	assert.equal(iterated.iteration_history.length, 2);
	assert.equal(iterated.iteration_history[0].kind, "selection");
	assert.equal(iterated.iteration_history[1].sequence, 2);
});

test("release gate requires independent screenshots, full QA, and recent-output novelty", () => {
	const root = mkdtempSync(join(tmpdir(), "design-direction-release-"));
	try {
		const brief = briefFor(...fixtures[3]);
		const direction = selectDirection(brief, { grammarId: "portfolio-canvas", selectedAt: NOW });
		mkdirSync(join(root, "site"), { recursive: true });
		writeJson(join(root, "design-brief.json"), brief);
		writeJson(join(root, "design-direction.json"), direction);
		const source = scaffoldSite(brief, direction);
		writeFileSync(join(root, "site/index.html"), source);
		mkdirSync(join(root, "qa"));
		const screenshots = [
			["qa/desktop.png", 1440, 1000, "desktop"],
			["qa/mobile.png", 390, 844, "mobile"],
			["qa/mobile-320.png", 320, 700, "mobile-320"],
		].map(([path, width, height, body]) => {
			writeFileSync(join(root, path), body);
			return { path, viewport: { width, height }, sha256: sha256(body) };
		});
		const other = fixtures.slice(0, 2).map(([grammarId, shape, offerings, qualities]) => {
			const otherBrief = briefFor(grammarId, shape, offerings, qualities);
			const otherDirection = selectDirection(otherBrief, { grammarId, selectedAt: NOW });
			return { label: grammarId, fingerprint: structuralFingerprint(scaffoldSite(otherBrief, otherDirection)) };
		});
		other[0] = {
			label: "business-fit structural precedent",
			fingerprint: structuralFingerprint(source),
			justification: {
				approved: true,
				rationale: "The source-backed creative practice needs the same image-led canvas topology; repetition is purposeful rather than a default.",
				evidence_refs: ["source-1"],
			},
		};
		writeJson(join(root, "design-review.json"), {
			schema_version: DESIGN_REVIEW_SCHEMA,
			reviewer: { kind: "independent", name: "synthetic-reviewer", reviewed_at: "2026-08-24T20:10:00.000Z" },
			screenshots,
			checks: {
				accessibility: true, responsive: true, content_fidelity: true, privacy: true,
				forms: true, assets: true, no_overflow: true, no_console_errors: true,
				no_unexpected_requests: true,
			},
			novelty: { maximum_similarity: 0.72, comparisons: other },
			existing_site_comparison: { evaluated: false, not_applicable_reason: "The source evidence confirms no existing site." },
		});
		assert.equal(validateProject(root, { stage: "candidate" }).ok, true);
		const release = validateProject(root, { stage: "release" });
		assert.equal(release.ok, true);
		assert.equal(release.review.similarity.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("existing-site cases fail closed when independent review finds no credible improvement", () => {
	const root = mkdtempSync(join(tmpdir(), "design-direction-existing-"));
	try {
		const base = briefFor(...fixtures[0]);
		const brief = {
			...base,
			evidence: [...base.evidence, { id: "existing-1", type: "public-site", source: "https://existing.example.com/", fact: "The current site is live and has complete service and contact information.", observed_at: NOW }],
			existing_site: { status: "live", url: "https://existing.example.com/", evidence_ids: ["existing-1"] },
		};
		const direction = selectDirection(brief, { grammarId: "editorial-ledger", selectedAt: NOW });
		mkdirSync(join(root, "site"), { recursive: true });
		mkdirSync(join(root, "qa"));
		writeJson(join(root, "design-brief.json"), brief);
		writeJson(join(root, "design-direction.json"), direction);
		writeFileSync(join(root, "site/index.html"), scaffoldSite(brief, direction));
		const shots = [[1440, "d"], [390, "m"], [320, "s"]].map(([width, body], index) => {
			const path = `qa/${index}.png`;
			writeFileSync(join(root, path), body);
			return { path, viewport: { width, height: 800 }, sha256: sha256(body) };
		});
		const comparisons = fixtures.slice(3, 5).map(([grammarId, shape, offerings, qualities]) => {
			const b = briefFor(grammarId, shape, offerings, qualities);
			return { label: grammarId, fingerprint: structuralFingerprint(scaffoldSite(b, selectDirection(b, { grammarId, selectedAt: NOW }))) };
		});
		writeJson(join(root, "design-review.json"), {
			schema_version: DESIGN_REVIEW_SCHEMA,
			reviewer: { kind: "independent", name: "synthetic-reviewer", reviewed_at: NOW },
			screenshots: shots,
			checks: { accessibility: true, responsive: true, content_fidelity: true, privacy: true, forms: true, assets: true, no_overflow: true, no_console_errors: true, no_unexpected_requests: true },
			novelty: { maximum_similarity: 0.72, comparisons },
			existing_site_comparison: { evaluated: true, url: "https://existing.example.com/", credible_improvement: false, rationale: "The candidate omits evidence already available on the current site.", evidence_refs: ["existing-1"] },
		});
		assert.throws(() => validateProject(root, { stage: "release" }), /not a credible improvement/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
