const ADDRESS = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class GmailEnvelopeParticipantError extends Error {
	constructor(reason, candidateCount) {
		const detail = {
			missing: "no external participant",
			ambiguous: "multiple external participants",
			invalid: "invalid participant fields",
		}[reason];
		super(`Gmail envelope has ${detail}`);
		this.name = "GmailEnvelopeParticipantError";
		this.code = `gmail_external_participant_${reason}`;
		this.candidateCount = candidateCount;
	}
}

function invalidEnvelope() {
	throw new GmailEnvelopeParticipantError("invalid");
}

function mailboxFields(value) {
	if (typeof value !== "string" || !value.trim()) return [];
	const fields = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	let commentDepth = 0;
	let angleDepth = 0;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && character === "\\") {
			escaped = true;
			continue;
		}
		if (commentDepth === 0 && character === '"') {
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (character === "(") {
			commentDepth++;
			continue;
		}
		if (character === ")") {
			if (commentDepth === 0) invalidEnvelope();
			commentDepth--;
			continue;
		}
		if (commentDepth > 0) continue;
		if (character === "<") {
			angleDepth++;
			if (angleDepth !== 1) invalidEnvelope();
			continue;
		}
		if (character === ">") {
			if (angleDepth !== 1) invalidEnvelope();
			angleDepth--;
			continue;
		}
		if (character === "," && angleDepth === 0) {
			fields.push(value.slice(start, index));
			start = index + 1;
		}
	}
	if (quoted || escaped || commentDepth !== 0 || angleDepth !== 0) invalidEnvelope();
	fields.push(value.slice(start));
	return fields;
}

function withoutComments(value) {
	let result = "";
	let depth = 0;
	for (const character of value) {
		if (character === "(") {
			depth++;
			continue;
		}
		if (character === ")") {
			if (depth === 0) invalidEnvelope();
			depth--;
			continue;
		}
		if (depth === 0) result += character;
	}
	if (depth !== 0) invalidEnvelope();
	return result;
}

function normalizedMailbox(field) {
	const firstOpen = field.indexOf("<");
	const firstClose = field.indexOf(">");
	let candidate;
	if (firstOpen === -1 && firstClose === -1) {
		candidate = withoutComments(field).trim().toLowerCase();
	} else {
		if (
			firstOpen === -1
			|| firstClose < firstOpen
			|| field.indexOf("<", firstOpen + 1) !== -1
			|| field.indexOf(">", firstClose + 1) !== -1
			|| withoutComments(field.slice(firstClose + 1)).trim()
		) invalidEnvelope();
		candidate = field.slice(firstOpen + 1, firstClose).trim().toLowerCase();
	}
	if (candidate.length > 254 || !ADDRESS.test(candidate)) invalidEnvelope();
	return candidate;
}

export function normalizedGmailHeaderMailboxes(value) {
	return mailboxFields(value).map(normalizedMailbox);
}

export function resolveGmailEnvelopeParticipant({ headers, account, internalDomains }) {
	const internalAccount = account.trim().toLowerCase();
	const domains = new Set(internalDomains.map((domain) => domain.toLowerCase()));
	const candidates = new Set();

	for (const header of [headers.from, headers.to, headers.cc]) {
		for (const address of normalizedGmailHeaderMailboxes(header)) {
			if (address === internalAccount) continue;
			const domain = address.slice(address.lastIndexOf("@") + 1);
			if (domains.has(domain)) continue;
			candidates.add(address);
		}
	}

	if (candidates.size === 0) throw new GmailEnvelopeParticipantError("missing", 0);
	if (candidates.size !== 1) {
		throw new GmailEnvelopeParticipantError("ambiguous", candidates.size);
	}
	return [...candidates][0];
}
