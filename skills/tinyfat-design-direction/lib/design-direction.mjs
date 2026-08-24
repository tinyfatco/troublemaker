import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DESIGN_BRIEF_SCHEMA = "tinyfat.design-brief/v1";
export const DESIGN_DIRECTION_SCHEMA = "tinyfat.design-direction/v1";
export const DESIGN_REVIEW_SCHEMA = "tinyfat.design-review/v1";
export const DEFAULT_NOVELTY_CEILING = 0.72;

const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = resolve(HERE, "../grammars/v1.json");
const SHAPES = new Set([
	"professional-service", "advisory", "legal", "financial", "care-service", "counseling",
	"wellness", "health", "local-trade", "home-service", "repair", "field-service",
	"creative-practice", "artist", "photography", "studio", "product-catalog", "retail",
	"maker", "food-product", "community", "event", "nonprofit", "personal-project", "unknown",
]);
const EVIDENCE_TYPES = new Set([
	"customer-message", "owner-brief", "public-site", "business-listing", "public-record",
	"reference", "interview", "source-document",
]);

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function loadGrammarLibrary() {
	const library = readJson(LIBRARY_PATH);
	if (library?.library_version !== "tinyfat.design-grammars/v1" || !Array.isArray(library.grammars)) {
		throw new Error("Design grammar library is invalid");
	}
	const ids = new Set();
	for (const grammar of library.grammars) {
		if (!grammar?.id || ids.has(grammar.id)) throw new Error("Design grammar IDs must be unique");
		ids.add(grammar.id);
		for (const field of [
			"business_shapes", "qualities", "information_architecture", "required_sections",
			"prohibited_defaults",
		]) {
			if (!Array.isArray(grammar[field]) || grammar[field].length === 0) {
				throw new Error(`Design grammar ${grammar.id} is missing ${field}`);
			}
		}
		for (const field of [
			"layout_topology", "typography", "density", "geometry", "imagery", "navigation",
			"interaction", "business_fit", "version",
		]) {
			if (typeof grammar[field] !== "string" || !grammar[field].trim()) {
				throw new Error(`Design grammar ${grammar.id} is missing ${field}`);
			}
		}
	}
	return library;
}

function requiredText(value, label, maximum = 2_000) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	if (value.length > maximum) throw new Error(`${label} is too long`);
	return value.trim();
}

function optionalText(value, label, maximum = 2_000) {
	if (value === undefined || value === null || value === "") return null;
	return requiredText(value, label, maximum);
}

function stringArray(value, label, { minimum = 0, maximum = 30 } = {}) {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
		throw new Error(`${label} must contain ${minimum}-${maximum} entries`);
	}
	const output = value.map((entry, index) => requiredText(entry, `${label}[${index}]`, 500));
	if (new Set(output.map((entry) => entry.toLowerCase())).size !== output.length) {
		throw new Error(`${label} contains duplicates`);
	}
	return output;
}

function validIsoTimestamp(value, label) {
	const text = requiredText(value, label, 100);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
		throw new Error(`${label} must be an ISO UTC timestamp`);
	}
	return text;
}

function validUrlOrNull(value, label) {
	if (value === null) return null;
	const text = requiredText(value, label, 2_000);
	const parsed = new URL(text);
	if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error(`${label} must use HTTP(S)`);
	return parsed.toString();
}

export function validateDesignBrief(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Design brief must be an object");
	if (input.schema_version !== DESIGN_BRIEF_SCHEMA) throw new Error("Unsupported design brief schema");
	const project = input.project || {};
	const slug = requiredText(project.slug, "project.slug", 80);
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw new Error("project.slug is invalid");
	const business = input.business || {};
	const shape = requiredText(business.shape, "business.shape", 80);
	if (!SHAPES.has(shape)) throw new Error(`Unsupported business.shape ${shape}`);
	const evidence = Array.isArray(input.evidence) ? input.evidence : [];
	if (evidence.length === 0 || evidence.length > 80) throw new Error("evidence must contain 1-80 source-backed entries");
	const evidenceIds = new Set();
	const normalizedEvidence = evidence.map((entry, index) => {
		const id = requiredText(entry?.id, `evidence[${index}].id`, 100);
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || evidenceIds.has(id)) throw new Error(`evidence[${index}].id is invalid or duplicated`);
		evidenceIds.add(id);
		const type = requiredText(entry?.type, `evidence[${index}].type`, 80);
		if (!EVIDENCE_TYPES.has(type)) throw new Error(`Unsupported evidence type ${type}`);
		return {
			id,
			type,
			source: requiredText(entry?.source, `evidence[${index}].source`, 1_000),
			fact: requiredText(entry?.fact, `evidence[${index}].fact`, 2_000),
			observed_at: validIsoTimestamp(entry?.observed_at, `evidence[${index}].observed_at`),
		};
	});
	const assumptions = (input.assumptions || []).map((entry, index) => {
		const refs = stringArray(entry?.evidence_ids, `assumptions[${index}].evidence_ids`, { minimum: 1, maximum: 20 });
		for (const ref of refs) if (!evidenceIds.has(ref)) throw new Error(`assumptions[${index}] references unknown evidence ${ref}`);
		if (!["low", "medium", "high"].includes(entry?.confidence)) throw new Error(`assumptions[${index}].confidence is invalid`);
		return {
			statement: requiredText(entry?.statement, `assumptions[${index}].statement`, 1_000),
			evidence_ids: refs,
			confidence: entry.confidence,
		};
	});
	const existing = input.existing_site || {};
	if (!["none", "unknown", "live"].includes(existing.status)) throw new Error("existing_site.status is invalid");
	const existingRefs = stringArray(existing.evidence_ids || [], "existing_site.evidence_ids", { minimum: existing.status === "live" ? 1 : 0, maximum: 20 });
	for (const ref of existingRefs) if (!evidenceIds.has(ref)) throw new Error(`existing_site references unknown evidence ${ref}`);
	const normalized = {
		schema_version: DESIGN_BRIEF_SCHEMA,
		project: { slug, name: requiredText(project.name, "project.name", 160) },
		business: {
			name: requiredText(business.name, "business.name", 160),
			shape,
			audiences: stringArray(business.audiences, "business.audiences", { minimum: 1 }),
			offerings: stringArray(business.offerings, "business.offerings", { minimum: 1 }),
			primary_actions: stringArray(business.primary_actions, "business.primary_actions", { minimum: 1, maximum: 8 }),
		},
		evidence: normalizedEvidence,
		desired_qualities: stringArray(input.desired_qualities || [], "desired_qualities", { minimum: 1, maximum: 20 }),
		avoided_qualities: stringArray(input.avoided_qualities || [], "avoided_qualities", { maximum: 20 }),
		references: (input.references || []).map((entry, index) => ({
			url: validUrlOrNull(entry?.url, `references[${index}].url`),
			note: requiredText(entry?.note, `references[${index}].note`, 1_000),
			evidence_ids: stringArray(entry?.evidence_ids, `references[${index}].evidence_ids`, { minimum: 1, maximum: 20 }),
		})),
		existing_site: {
			status: existing.status,
			url: validUrlOrNull(existing.url ?? null, "existing_site.url"),
			evidence_ids: existingRefs,
		},
		optional_open_questions: stringArray(input.optional_open_questions || [], "optional_open_questions", { maximum: 12 }),
		assumptions,
		provenance: {
			created_at: validIsoTimestamp(input.provenance?.created_at, "provenance.created_at"),
			created_by: requiredText(input.provenance?.created_by, "provenance.created_by", 120),
			source_refs: stringArray(input.provenance?.source_refs, "provenance.source_refs", { minimum: 1, maximum: 40 }),
		},
	};
	if (normalized.existing_site.status === "live" && !normalized.existing_site.url) {
		throw new Error("A live existing site requires its public URL");
	}
	if (normalized.references.some((entry) => entry.evidence_ids.some((ref) => !evidenceIds.has(ref)))) {
		throw new Error("A reference points to unknown evidence");
	}
	return normalized;
}

function tokens(values) {
	return new Set(values.flatMap((value) => String(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
}

function intersectCount(left, right) {
	let count = 0;
	for (const value of left) if (right.has(value)) count += 1;
	return count;
}

export function planInterview(input) {
	const brief = validateDesignBrief(input);
	const missingShape = brief.business.shape === "unknown";
	const weakShapeEvidence = brief.evidence.filter((entry) => ["customer-message", "owner-brief", "public-site", "business-listing", "interview"].includes(entry.type)).length < 2;
	const focusedQuestion = missingShape && weakShapeEvidence
		? {
			topic: "primary-purpose",
			reason: "The evidence does not yet distinguish the site's primary job.",
			prompt_goal: "Ask what a successful visitor should understand or do first.",
		}
		: null;
	return {
		acknowledge_before_question: true,
		use_existing_evidence_first: true,
		focused_question: focusedQuestion,
		may_proceed: focusedQuestion === null || brief.business.offerings.length > 0,
		optional_questions_are_non_blocking: true,
		state_assumptions: brief.assumptions.map((entry) => entry.statement),
		open_details: brief.optional_open_questions,
	};
}

export function selectDirection(input, { grammarId, selectedAt = new Date().toISOString() } = {}) {
	const brief = validateDesignBrief(input);
	const library = loadGrammarLibrary();
	let grammar;
	const rationale = [];
	if (!grammarId && planInterview(brief).focused_question) {
		throw new Error("Direction selection remains ambiguous; ask one focused primary-purpose question");
	}
	if (grammarId) {
		grammar = library.grammars.find((candidate) => candidate.id === grammarId);
		if (!grammar) throw new Error(`Unknown design grammar ${grammarId}`);
		rationale.push(`The ${grammar.id} grammar was explicitly selected after evidence review.`);
	} else {
		const desired = tokens(brief.desired_qualities);
		const avoided = tokens(brief.avoided_qualities);
		const scored = library.grammars.map((candidate) => {
			const qualities = tokens(candidate.qualities);
			let score = candidate.business_shapes.includes(brief.business.shape) ? 20 : 0;
			score += intersectCount(desired, qualities) * 3;
			score -= intersectCount(avoided, qualities) * 4;
			return { candidate, score };
		}).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
		grammar = scored[0].candidate;
		rationale.push(`${grammar.id} best fits the verified ${brief.business.shape} shape and desired qualities.`);
		if (scored[0].score === scored[1]?.score && brief.business.shape === "unknown") {
			throw new Error("Direction selection remains ambiguous; ask one focused primary-purpose question");
		}
	}
	const evidenceRefs = brief.evidence.map((entry) => entry.id);
	if (evidenceRefs.length === 0) throw new Error("Direction selection requires source-backed evidence");
	return {
		schema_version: DESIGN_DIRECTION_SCHEMA,
		project_slug: brief.project.slug,
		grammar: { id: grammar.id, version: grammar.version, library_version: library.library_version },
		selected_at: validIsoTimestamp(selectedAt, "selected_at"),
		evidence_refs: evidenceRefs,
		rationale,
		pattern_justification: {
			summary: grammar.business_fit,
			evidence_refs: evidenceRefs,
		},
		constraints: {
			information_architecture: [...grammar.information_architecture],
			layout_topology: grammar.layout_topology,
			typography: grammar.typography,
			density: grammar.density,
			geometry: grammar.geometry,
			imagery: grammar.imagery,
			navigation: grammar.navigation,
			interaction: grammar.interaction,
			required_sections: [...grammar.required_sections],
			prohibited_defaults: [...grammar.prohibited_defaults],
		},
		iteration_history: [{
			sequence: 1,
			at: validIsoTimestamp(selectedAt, "selected_at"),
			kind: "selection",
			summary: `Selected ${grammar.id} from source-backed business and interview evidence.`,
			evidence_refs: evidenceRefs,
		}],
	};
}

export function validateDirection(input, briefInput) {
	const brief = validateDesignBrief(briefInput);
	if (!input || typeof input !== "object" || input.schema_version !== DESIGN_DIRECTION_SCHEMA) {
		throw new Error("Unsupported design direction schema");
	}
	if (input.project_slug !== brief.project.slug) throw new Error("Design direction project does not match brief");
	const library = loadGrammarLibrary();
	const grammar = library.grammars.find((candidate) => candidate.id === input.grammar?.id);
	if (!grammar || input.grammar?.version !== grammar.version || input.grammar?.library_version !== library.library_version) {
		throw new Error("Design direction grammar provenance does not match the installed library");
	}
	const evidenceIds = new Set(brief.evidence.map((entry) => entry.id));
	const refs = stringArray(input.evidence_refs, "direction.evidence_refs", { minimum: 1, maximum: 80 });
	for (const ref of refs) if (!evidenceIds.has(ref)) throw new Error(`Direction references unknown evidence ${ref}`);
	requiredText(input.pattern_justification?.summary, "direction.pattern_justification.summary", 2_000);
	const patternRefs = stringArray(input.pattern_justification?.evidence_refs, "direction.pattern_justification.evidence_refs", { minimum: 1, maximum: 80 });
	for (const ref of patternRefs) if (!evidenceIds.has(ref)) throw new Error(`Pattern justification references unknown evidence ${ref}`);
	for (const field of ["layout_topology", "typography", "density", "geometry", "imagery", "navigation", "interaction"]) {
		if (input.constraints?.[field] !== grammar[field]) throw new Error(`Direction constraint ${field} drifted from its grammar`);
	}
	for (const field of ["information_architecture", "required_sections", "prohibited_defaults"]) {
		if (JSON.stringify(input.constraints?.[field]) !== JSON.stringify(grammar[field])) {
			throw new Error(`Direction constraint ${field} drifted from its grammar`);
		}
	}
	if (!Array.isArray(input.iteration_history) || input.iteration_history.length === 0) throw new Error("Direction needs durable iteration history");
	let expected = 1;
	for (const entry of input.iteration_history) {
		if (entry.sequence !== expected++) throw new Error("Direction iteration history is not sequential");
		validIsoTimestamp(entry.at, `iteration_history[${entry.sequence - 1}].at`);
		requiredText(entry.kind, "iteration kind", 80);
		requiredText(entry.summary, "iteration summary", 1_000);
		for (const ref of stringArray(entry.evidence_refs, "iteration evidence_refs", { minimum: 1, maximum: 80 })) {
			if (!evidenceIds.has(ref)) throw new Error(`Iteration references unknown evidence ${ref}`);
		}
	}
	return { brief, direction: input, grammar };
}

export function recordIteration(directionInput, briefInput, { kind, summary, evidenceRefs, at = new Date().toISOString() }) {
	validateDirection(directionInput, briefInput);
	const next = structuredClone(directionInput);
	const refs = stringArray(evidenceRefs, "iteration evidence_refs", { minimum: 1, maximum: 80 });
	next.iteration_history.push({
		sequence: next.iteration_history.length + 1,
		at: validIsoTimestamp(at, "iteration.at"),
		kind: requiredText(kind, "iteration.kind", 80),
		summary: requiredText(summary, "iteration.summary", 1_000),
		evidence_refs: refs,
	});
	validateDirection(next, briefInput);
	return next;
}

function escapeHtml(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function pageShell({ title, grammar, body, css }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="tinyfat-design-direction" content="${escapeHtml(grammar.id)}@${escapeHtml(grammar.version)}">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body data-design-grammar="${escapeHtml(grammar.id)}">
${body}
</body>
</html>\n`;
}

function commonCss() {
	return `*{box-sizing:border-box;min-width:0}html{scroll-behavior:smooth}body{margin:0;overflow-wrap:anywhere}a{color:inherit}img,svg{max-width:100%;height:auto}button,input,textarea,select{font:inherit}:focus-visible{outline:3px solid currentColor;outline-offset:3px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}`;
}

function offeringRows(brief, tag = "li") {
	return brief.business.offerings.map((offering, index) => `<${tag}><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(offering)}</${tag}>`).join("\n");
}

const RENDERERS = {
	"editorial-ledger": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#17202a;--paper:#f2efe8;--line:#777067;--accent:#8d2f23}body{background:var(--paper);color:var(--ink);font-family:Arial,sans-serif}.mast{display:grid;grid-template-columns:1fr auto;border-bottom:2px solid var(--ink);padding:18px 4vw;align-items:end}.mast strong{font:700 clamp(1.8rem,4vw,4.8rem)/.86 Georgia,serif;max-width:12ch}.mast nav{display:flex;gap:18px;font-size:.76rem;text-transform:uppercase;letter-spacing:.12em}.document{display:grid;grid-template-columns:minmax(190px,24vw) 1fr;min-height:80vh}.rail{border-right:1px solid var(--line);padding:5vw 3vw}.rail p{font:italic 1.05rem/1.55 Georgia,serif}.ledger{padding:5vw 6vw}.ledger h1{font:400 clamp(2.6rem,7vw,7.8rem)/.9 Georgia,serif;max-width:11ch;margin:0 0 6vw}.services{list-style:none;padding:0;border-top:1px solid}.services li{display:grid;grid-template-columns:4rem 1fr;gap:1rem;padding:1rem 0;border-bottom:1px solid;font:600 clamp(1.1rem,2vw,2rem)/1.2 Georgia,serif}.method{max-width:58ch;margin:6vw 0;font-size:1.05rem;line-height:1.7}.contact{border-top:2px solid;padding:2rem 0;display:flex;justify-content:space-between;gap:2rem}@media(max-width:720px){.mast{grid-template-columns:1fr}.mast nav{margin-top:20px;flex-wrap:wrap}.document{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid}.ledger{padding:12vw 6vw}.contact{display:block}.contact a{display:block;margin-top:1rem}}`, body: `<header class="mast" data-dd-section="masthead"><strong>${escapeHtml(brief.business.name)}</strong><nav aria-label="Primary"><a href="#services">Services</a><a href="#method">Approach</a><a href="#contact">Contact</a></nav></header>
<div class="document"><aside class="rail" data-dd-section="evidence-rail"><small>For</small><p>${escapeHtml(brief.business.audiences[0])}</p></aside><main class="ledger"><h1>${escapeHtml(brief.project.name)}</h1><section id="services" data-dd-section="service-ledger"><ol class="services">${offeringRows(brief)}</ol></section><section id="method" class="method" data-dd-section="method-note"><h2>A clear place to begin</h2><p>${escapeHtml(brief.business.primary_actions[0])}</p></section><footer id="contact" class="contact" data-dd-section="direct-contact"><strong>${escapeHtml(brief.business.name)}</strong><a href="#contact">${escapeHtml(brief.business.primary_actions[0])}</a></footer></main></div>` }),
	"guided-care-path": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#26352f;--paper:#f7f1e8;--sage:#9eb09f;--rose:#d8b7ad}body{background:var(--paper);color:var(--ink);font:1rem/1.65 Arial,sans-serif}.quiet{display:flex;justify-content:space-between;padding:24px 5vw;align-items:center}.quiet nav{display:flex;gap:24px}.welcome{display:grid;grid-template-columns:1.1fr .9fr;min-height:68vh;align-items:center;padding:6vw 7vw;gap:8vw}.welcome h1{font:400 clamp(3rem,7vw,7rem)/.95 Georgia,serif;margin:0}.calm-plane{min-height:45vh;background:var(--sage);clip-path:polygon(8% 0,100% 8%,92% 100%,0 88%);display:grid;place-items:center}.calm-plane span{font:italic 1.2rem Georgia,serif;max-width:15ch}.choices{display:flex;justify-content:center;gap:1px;background:var(--ink);margin:0 6vw}.choices a{background:var(--paper);padding:1.5rem 3rem;flex:1;text-align:center}.path{max-width:800px;margin:8vw auto;padding:0 5vw}.path ol{counter-reset:step;list-style:none;padding:0}.path li{counter-increment:step;display:grid;grid-template-columns:4rem 1fr;padding:1.5rem 0;border-top:1px solid}.path li:before{content:counter(step,decimal-leading-zero);font-family:Georgia,serif}.resources{background:#e4d9cd;padding:5vw 8vw;display:grid;grid-template-columns:1fr 2fr;gap:5vw}.private{padding:6vw;text-align:left;border-top:12px solid var(--sage)}@media(max-width:720px){.quiet nav{display:none}.welcome{grid-template-columns:1fr;padding:12vw 6vw}.calm-plane{min-height:28vh}.choices{display:block}.choices a{display:block}.resources{grid-template-columns:1fr}.path{margin:16vw auto}}`, body: `<header class="quiet" data-dd-section="quiet-header"><strong>${escapeHtml(brief.business.name)}</strong><nav aria-label="Primary"><a href="#care">Ways to meet</a><a href="#resources">Resources</a><a href="#contact">Start gently</a></nav></header><main><section class="welcome" data-dd-section="welcome-split"><div><p>For ${escapeHtml(brief.business.audiences[0])}</p><h1>${escapeHtml(brief.project.name)}</h1></div><div class="calm-plane" aria-hidden="true"><span>A quieter path forward.</span></div></section><nav id="care" class="choices" data-dd-section="care-choices" aria-label="Care options">${brief.business.offerings.slice(0,3).map((item)=>`<a href="#path">${escapeHtml(item)}</a>`).join("")}</nav><section id="path" class="path" data-dd-section="visit-path"><h2>What happens next</h2><ol>${brief.business.primary_actions.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ol></section><section id="resources" class="resources" data-dd-section="resource-shelf"><h2>Resources at your pace</h2><p>${escapeHtml(brief.business.offerings.join(" · "))}</p></section><footer id="contact" class="private" data-dd-section="private-contact"><h2>${escapeHtml(brief.business.primary_actions[0])}</h2><p>No pressure. Begin with the option that feels useful.</p></footer></main>` }),
	"trade-dispatch": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#111;--paper:#f3f0e6;--signal:#ff5c35}body{background:var(--paper);color:var(--ink);font:700 1rem/1.35 Arial,sans-serif;text-transform:uppercase}.dispatch{display:grid;grid-template-columns:1fr auto;background:var(--signal);border-bottom:4px solid;padding:16px 3vw;letter-spacing:.06em}.board{display:grid;grid-template-columns:1.2fr .8fr;min-height:75vh}.map{padding:5vw;border-right:4px solid}.map h1{font:900 clamp(3rem,9vw,9rem)/.78 Impact,Arial,sans-serif;margin:0;letter-spacing:-.03em}.sequence{list-style:none;padding:0;margin:5vw 0;border-top:4px solid}.sequence li{display:grid;grid-template-columns:5rem 1fr;border-bottom:4px solid;padding:1rem 0}.proof{padding:4vw;background:#fff}.proof h2,.quote h2{font:900 2.5rem/1 Impact,sans-serif}.proof-board{display:grid;gap:0}.proof-board div{border:2px solid;padding:1.5rem;margin-top:-2px}.quote{background:var(--ink);color:white;padding:4vw;display:flex;justify-content:space-between;align-items:end}.quote a{background:var(--signal);color:var(--ink);padding:1rem;text-decoration:none}@media(max-width:760px){.dispatch{grid-template-columns:1fr}.board{grid-template-columns:1fr}.map{border-right:0;border-bottom:4px solid}.proof{padding:10vw 5vw}.quote{display:block}.quote a{display:block;margin-top:20px}}`, body: `<header class="dispatch" data-dd-section="dispatch-bar"><strong>${escapeHtml(brief.business.name)}</strong><span>${escapeHtml(brief.business.primary_actions[0])}</span></header><main><div class="board"><section class="map" data-dd-section="service-map"><p>Service board</p><h1>${escapeHtml(brief.project.name)}</h1><ol class="sequence" data-dd-section="job-sequence">${offeringRows(brief)}</ol></section><section class="proof" data-dd-section="proof-board"><h2>What we handle</h2><div class="proof-board">${brief.business.offerings.map((item)=>`<div>${escapeHtml(item)}</div>`).join("")}</div></section></div><aside class="quote" data-dd-section="quote-panel"><div><small>Next step</small><h2>${escapeHtml(brief.business.primary_actions[0])}</h2></div><a href="#contact">Check the job</a></aside></main>` }),
	"portfolio-canvas": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#151515;--paper:#ece9e2;--flash:#e8ff32}body{margin:0;background:var(--paper);color:var(--ink);font:1rem/1.4 Arial,sans-serif}.wordmark{position:fixed;z-index:2;left:0;top:0;bottom:0;width:72px;border-right:1px solid;display:flex;align-items:center;justify-content:center;background:var(--paper)}.wordmark strong{writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:.15em}.canvas{margin-left:72px}.index{padding:20px 4vw;display:flex;justify-content:flex-end;gap:18px}.work{display:grid;grid-template-columns:repeat(12,1fr);padding:4vw;gap:2vw;min-height:80vh}.plane{background:var(--ink);color:white;min-height:45vh;display:grid;place-items:end start;padding:3vw}.plane:nth-child(1){grid-column:1/9}.plane:nth-child(2){grid-column:8/13;margin-top:18vh;background:var(--flash);color:var(--ink)}.caption{grid-column:2/7;font:400 clamp(2rem,5vw,5rem)/.95 Georgia,serif}.note{margin:8vw 8vw 8vw 16vw;max-width:55ch;font-size:1.3rem}.inquiry{margin-left:72px;border-top:1px solid;padding:4vw 6vw;display:grid;grid-template-columns:1fr auto}@media(max-width:700px){.wordmark{position:static;width:auto;height:60px;border-right:0;border-bottom:1px solid}.wordmark strong{writing-mode:initial;transform:none}.canvas,.inquiry{margin-left:0}.work{display:block;padding:6vw}.plane{margin:0 0 6vw!important;min-height:38vh}.caption{margin:14vw 0}.note{margin:16vw 8vw}.inquiry{grid-template-columns:1fr}}`, body: `<header class="wordmark" data-dd-section="wordmark-index"><strong>${escapeHtml(brief.business.name)}</strong></header><main class="canvas"><nav class="index" aria-label="Project index">${brief.business.offerings.slice(0,4).map((item,index)=>`<a href="#work-${index+1}">${String(index+1).padStart(2,"0")}</a>`).join("")}</nav><section class="work" data-dd-section="work-canvas">${brief.business.offerings.slice(0,2).map((item,index)=>`<figure id="work-${index+1}" class="plane"><figcaption>${escapeHtml(item)}</figcaption></figure>`).join("")}<h1 class="caption" data-dd-section="project-caption">${escapeHtml(brief.project.name)}</h1></section><section class="note" data-dd-section="studio-note"><h2>About the work</h2><p>Created for ${escapeHtml(brief.business.audiences[0])}.</p></section></main><footer class="inquiry" data-dd-section="inquiry-line"><strong>${escapeHtml(brief.business.primary_actions[0])}</strong><a href="#contact">Start a conversation</a></footer>` }),
	"catalog-workbench": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#202020;--paper:#f8f4e8;--label:#d9ff6b}body{background:var(--paper);color:var(--ink);font:500 .95rem/1.35 Arial,sans-serif}.commerce{display:flex;justify-content:space-between;padding:14px 24px;border-bottom:2px solid}.bench{display:grid;grid-template-columns:240px 1fr;min-height:80vh}.catalog{border-right:2px solid;padding:2rem 1.5rem;position:sticky;top:0;height:100vh}.catalog a{display:block;padding:.7rem 0;border-bottom:1px solid;text-decoration:none}.products{padding:2rem 3vw}.products h1{font:900 clamp(3rem,8vw,8rem)/.8 Arial,sans-serif;letter-spacing:-.07em;margin:1rem 0 4rem}.table{border-top:2px solid}.specimen{display:grid;grid-template-columns:5rem 1fr auto;gap:1rem;padding:1.25rem 0;border-bottom:2px solid;align-items:center}.specimen span:first-child{background:var(--label);width:3rem;height:3rem;display:grid;place-items:center}.detail{margin:6vw 0;display:grid;grid-template-columns:1fr 1fr;border:2px solid}.detail>*{padding:3vw}.detail>*+*{border-left:2px solid}.order{background:var(--ink);color:white;padding:3rem;display:grid;grid-template-columns:1fr auto}@media(max-width:720px){.bench{grid-template-columns:1fr}.catalog{position:static;height:auto;border-right:0;border-bottom:2px solid}.products{padding:10vw 5vw}.specimen{grid-template-columns:3rem 1fr}.specimen span:last-child{grid-column:2}.detail{grid-template-columns:1fr}.detail>*+*{border-left:0;border-top:2px solid}.order{grid-template-columns:1fr}}`, body: `<header class="commerce" data-dd-section="commerce-strip"><strong>${escapeHtml(brief.business.name)}</strong><span>${escapeHtml(brief.business.primary_actions[0])}</span></header><div class="bench"><aside class="catalog" data-dd-section="catalog-index"><h2>Index</h2>${brief.business.offerings.map((item,index)=>`<a href="#item-${index+1}">${String(index+1).padStart(2,"0")} ${escapeHtml(item)}</a>`).join("")}</aside><main class="products"><h1>${escapeHtml(brief.project.name)}</h1><section class="table" data-dd-section="product-table">${brief.business.offerings.map((item,index)=>`<article id="item-${index+1}" class="specimen"><span>${index+1}</span><strong>${escapeHtml(item)}</strong><span>Details available</span></article>`).join("")}</section><section class="detail" data-dd-section="detail-bench"><h2>Made for ${escapeHtml(brief.business.audiences[0])}</h2><p>Clear product details and availability belong here before ordering is enabled.</p></section></main></div><footer class="order" data-dd-section="order-note"><strong>${escapeHtml(brief.business.primary_actions[0])}</strong><span>Availability must be confirmed.</span></footer>` }),
	"community-bulletin": (brief, grammar) => pageShell({ title: brief.business.name, grammar, css: `${commonCss()}
:root{--ink:#24302a;--paper:#fff8df;--red:#db4b38;--blue:#8bc1c5}body{background:var(--paper);color:var(--ink);font:1rem/1.45 Arial,sans-serif}.date-mast{padding:2vw 4vw;border-bottom:3px double;display:grid;grid-template-columns:1fr auto;align-items:end}.date-mast h1{font:900 clamp(3rem,8vw,8rem)/.8 Georgia,serif;margin:.5rem 0}.tabs{display:flex;border-bottom:2px solid}.tabs a{padding:1rem 2rem;border-right:2px solid;text-decoration:none}.bulletin{display:grid;grid-template-columns:1.4fr .6fr;gap:0}.feed{padding:4vw;border-right:2px solid}.lead{background:var(--red);color:white;padding:4vw;transform:rotate(-.5deg);margin-bottom:4vw}.lead h2{font:700 clamp(2rem,5vw,5rem)/.95 Georgia,serif}.notices{columns:2;column-gap:2vw}.notice{break-inside:avoid;border-top:2px solid;padding:1rem 0 3rem}.calendar{padding:4vw;background:var(--blue)}.calendar li{padding:1rem 0;border-bottom:1px solid}.participate{padding:3vw 4vw;border-top:3px double;display:flex;justify-content:space-between}@media(max-width:760px){.date-mast{grid-template-columns:1fr}.tabs{overflow:auto}.bulletin{grid-template-columns:1fr}.feed{border-right:0}.notices{columns:1}.participate{display:block}}@media(max-width:520px){.tabs{display:block}.tabs a{display:block;border-right:0;border-bottom:1px solid}}`, body: `<header class="date-mast" data-dd-section="date-mast"><div><small>Community bulletin</small><h1>${escapeHtml(brief.business.name)}</h1></div><strong>${escapeHtml(brief.project.name)}</strong></header><nav class="tabs" data-dd-section="bulletin-tabs" aria-label="Topics">${brief.business.offerings.slice(0,4).map((item)=>`<a href="#notices">${escapeHtml(item)}</a>`).join("")}</nav><main class="bulletin"><div class="feed"><section class="lead" data-dd-section="lead-notice"><h2>${escapeHtml(brief.business.primary_actions[0])}</h2><p>For ${escapeHtml(brief.business.audiences[0])}</p></section><section id="notices" class="notices" data-dd-section="notice-feed">${brief.business.offerings.map((item)=>`<article class="notice"><h3>${escapeHtml(item)}</h3><p>Current details belong here.</p></article>`).join("")}</section></div><aside class="calendar" data-dd-section="calendar-rail"><h2>At a glance</h2><ol>${offeringRows(brief)}</ol></aside></main><footer class="participate" data-dd-section="participation-footer"><strong>${escapeHtml(brief.business.primary_actions[0])}</strong><span>${escapeHtml(brief.business.name)}</span></footer>` }),
};

export function scaffoldSite(briefInput, directionInput) {
	const { brief, grammar } = validateDirection(directionInput, briefInput);
	const renderer = RENDERERS[grammar.id];
	if (!renderer) throw new Error(`No executable renderer exists for ${grammar.id}`);
	return renderer(brief, grammar);
}

function classTokens(source) {
	const output = new Set();
	for (const match of source.matchAll(/\b(?:class|data-dd-section)=["']([^"']+)["']/gi)) {
		for (const token of match[1].toLowerCase().split(/\s+/)) if (token) output.add(token);
	}
	for (const match of source.matchAll(/<([a-z][a-z0-9-]*)\b/gi)) output.add(`tag:${match[1].toLowerCase()}`);
	return [...output].sort();
}

export function structuralFingerprint(source) {
	const fingerprint = {
		tokens: classTokens(source),
		sections: [...source.matchAll(/data-dd-section=["']([^"']+)["']/gi)].map((match) => match[1]).sort(),
		headings: {
			h1: (source.match(/<h1\b/gi) || []).length,
			h2: (source.match(/<h2\b/gi) || []).length,
			h3: (source.match(/<h3\b/gi) || []).length,
		},
		landmarks: Object.fromEntries(["header", "nav", "main", "aside", "section", "article", "figure", "footer"].map((tag) => [tag, (source.match(new RegExp(`<${tag}\\b`, "gi")) || []).length])),
	};
	return { ...fingerprint, digest: sha256(JSON.stringify(fingerprint)) };
}

export function fingerprintSimilarity(left, right) {
	const a = new Set(left.tokens || []);
	const b = new Set(right.tokens || []);
	const union = new Set([...a, ...b]);
	if (union.size === 0) return 1;
	return intersectCount(a, b) / union.size;
}

function defaultSignals(source) {
	const checks = {
		"centered-hero": /(?:class=["'][^"']*hero[^"']*["'][\s\S]{0,1600}text-align\s*:\s*center)|(?:text-align\s*:\s*center[\s\S]{0,1600}class=["'][^"']*hero)/i.test(source),
		"rounded-card-grid": /class=["'][^"']*(?:card-grid|grid-cards|cards)[^"']*["']/i.test(source) && /border-radius\s*:/i.test(source),
		"rounded-three-card-grid": (source.match(/class=["'][^"']*card[^"']*["']/gi) || []).length >= 3 && /display\s*:\s*grid/i.test(source),
		"gradient-wash": /(?:linear|radial|conic)-gradient\s*\(/i.test(source),
		"pill-buttons": /border-radius\s*:\s*(?:9999?|100)%?px/i.test(source) || /class=["'][^"']*pill[^"']*["']/i.test(source),
		"floating-chat-pressure": /class=["'][^"']*(?:chat|floating-cta)[^"']*["']/i.test(source),
		"decorative-testimonial-carousel": /(?:testimonial[\s\S]{0,100}carousel|carousel[\s\S]{0,100}testimonial)/i.test(source),
		"generic-stock-gallery": /(?:stock-photo|unsplash\.com|images\.pexels\.com)/i.test(source),
		"fake-checkout": /(?:add to cart|checkout now|buy now)/i.test(source),
		"conversion-funnel": /(?:limited time|act now|only \d+ left)/i.test(source),
	};
	return Object.entries(checks).filter(([, value]) => value).map(([name]) => name);
}

export function validateSiteSource(source, directionInput, briefInput) {
	const { grammar } = validateDirection(directionInput, briefInput);
	if (!/<meta\s+name=["']tinyfat-design-direction["']\s+content=["'][^"']+["']\s*\/?>/i.test(source)) {
		throw new Error("Site is missing the executable design-direction provenance marker");
	}
	if (!new RegExp(`data-design-grammar=["']${grammar.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(source)) {
		throw new Error("Site does not bind the selected design grammar");
	}
	for (const section of grammar.required_sections) {
		if (!new RegExp(`data-dd-section=["']${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(source)) {
			throw new Error(`Site is missing required ${grammar.id} section ${section}`);
		}
	}
	const signals = defaultSignals(source);
	for (const prohibited of grammar.prohibited_defaults) {
		if (signals.includes(prohibited)) throw new Error(`Site regressed to prohibited default ${prohibited}`);
	}
	if (/\b(?:lorem ipsum|placeholder copy|todo:|replace me|generated by ai)\b/i.test(source)) {
		throw new Error("Site contains unfinished or internal placeholder language");
	}
	if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(source)) throw new Error("Site must declare document language");
	if (!/<meta\s+name=["']viewport["']/i.test(source)) throw new Error("Site must declare a mobile viewport");
	if ((source.match(/<h1\b/gi) || []).length !== 1) throw new Error("Site must contain exactly one h1");
	return { grammar: grammar.id, signals, fingerprint: structuralFingerprint(source) };
}

function validateReview(input, { brief, sourceFingerprint, projectDirectory }) {
	if (!input || input.schema_version !== DESIGN_REVIEW_SCHEMA) throw new Error("Release requires a design review v1 receipt");
	if (input.reviewer?.kind !== "independent") throw new Error("Release review must be independent from the builder");
	requiredText(input.reviewer?.name, "reviewer.name", 120);
	validIsoTimestamp(input.reviewer?.reviewed_at, "reviewer.reviewed_at");
	const screenshots = Array.isArray(input.screenshots) ? input.screenshots : [];
	const widths = screenshots.map((entry, index) => {
		const path = requiredText(entry?.path, `screenshots[${index}].path`, 240);
		if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) throw new Error("Screenshot path must stay inside the project");
		const full = resolve(projectDirectory, path);
		if (!full.startsWith(`${resolve(projectDirectory)}/`) || !existsSync(full)) throw new Error(`Screenshot ${path} is missing`);
		const bytes = readFileSync(full);
		if (sha256(bytes) !== entry.sha256) throw new Error(`Screenshot ${path} hash mismatch`);
		if (!Number.isInteger(entry.viewport?.width) || !Number.isInteger(entry.viewport?.height)) throw new Error("Screenshot viewport is invalid");
		return entry.viewport.width;
	});
	if (!widths.some((width) => width >= 1280) || !widths.some((width) => width >= 360 && width <= 430) || !widths.some((width) => width === 320)) {
		throw new Error("Release review requires desktop, common-phone, and exact 320px screenshots");
	}
	for (const check of ["accessibility", "responsive", "content_fidelity", "privacy", "forms", "assets", "no_overflow", "no_console_errors", "no_unexpected_requests"]) {
		if (input.checks?.[check] !== true) throw new Error(`Release review check ${check} did not pass`);
	}
	const comparisons = input.novelty?.comparisons;
	if (!Array.isArray(comparisons) || comparisons.length < 2) throw new Error("Release review needs at least two recent-output structural comparisons");
	const ceiling = input.novelty?.maximum_similarity ?? DEFAULT_NOVELTY_CEILING;
	if (typeof ceiling !== "number" || ceiling <= 0 || ceiling > DEFAULT_NOVELTY_CEILING) throw new Error("Novelty ceiling is invalid");
	const similarity = comparisons.map((entry, index) => {
		requiredText(entry?.label, `novelty.comparisons[${index}].label`, 160);
		if (!entry?.fingerprint || !Array.isArray(entry.fingerprint.tokens)) throw new Error("Novelty comparison fingerprint is invalid");
		return { label: entry.label, score: fingerprintSimilarity(sourceFingerprint, entry.fingerprint), justification: entry.justification };
	});
	const evidenceIds = new Set(brief.evidence.map((entry) => entry.id));
	for (const result of similarity) {
		if (result.score <= ceiling) continue;
		if (result.justification?.approved !== true) {
			throw new Error(`Site repeats the recent ${result.label} skeleton without positive business justification (${result.score.toFixed(3)} > ${ceiling})`);
		}
		requiredText(result.justification.rationale, `novelty justification for ${result.label}`, 2_000);
		for (const ref of stringArray(result.justification.evidence_refs, `novelty justification evidence for ${result.label}`, { minimum: 1, maximum: 30 })) {
			if (!evidenceIds.has(ref)) throw new Error(`Novelty justification references unknown evidence ${ref}`);
		}
	}
	const comparison = input.existing_site_comparison || {};
	if (brief.existing_site.status === "live") {
		if (comparison.evaluated !== true || comparison.url !== brief.existing_site.url) throw new Error("Live existing site was not evaluated against the candidate");
		if (comparison.credible_improvement !== true) throw new Error("Candidate is not a credible improvement over the existing site");
		requiredText(comparison.rationale, "existing_site_comparison.rationale", 2_000);
		const refs = stringArray(comparison.evidence_refs, "existing_site_comparison.evidence_refs", { minimum: 1, maximum: 30 });
		const evidenceIds = new Set(brief.evidence.map((entry) => entry.id));
		for (const ref of refs) if (!evidenceIds.has(ref)) throw new Error(`Existing-site comparison references unknown evidence ${ref}`);
	} else if (comparison.evaluated !== false || !optionalText(comparison.not_applicable_reason, "existing_site_comparison.not_applicable_reason")) {
		throw new Error("Review must explain why existing-site comparison is not applicable");
	}
	return { similarity, ceiling };
}

export function validateProject(projectDirectory, { stage = "candidate" } = {}) {
	if (!new Set(["candidate", "release"]).has(stage)) throw new Error("Stage must be candidate or release");
	const root = resolve(projectDirectory);
	const brief = readJson(join(root, "design-brief.json"));
	const direction = readJson(join(root, "design-direction.json"));
	const sourcePath = join(root, "site/index.html");
	if (!existsSync(sourcePath)) throw new Error("Project is missing site/index.html");
	const source = readFileSync(sourcePath, "utf8");
	const sourceResult = validateSiteSource(source, direction, brief);
	let review = null;
	if (stage === "release") {
		const reviewPath = join(root, "design-review.json");
		if (!existsSync(reviewPath)) throw new Error("Release is missing design-review.json");
		review = validateReview(readJson(reviewPath), {
			brief: validateDesignBrief(brief),
			sourceFingerprint: sourceResult.fingerprint,
			projectDirectory: root,
		});
	}
	return {
		ok: true,
		stage,
		grammar: sourceResult.grammar,
		source_sha256: sha256(source),
		fingerprint: sourceResult.fingerprint,
		review,
	};
}
