export interface EmailReplyThreadHeaders {
	in_reply_to?: string;
	references?: string;
}

function uuidLike(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function keyForMessageId(headerValue: string): string {
	const inner = headerValue.startsWith("<") && headerValue.endsWith(">")
		? headerValue.slice(1, -1)
		: headerValue;
	const at = inner.lastIndexOf("@");
	if (at === -1) return inner;
	return `${inner.slice(0, at)}@${inner.slice(at + 1).toLowerCase()}`;
}

export function normalizeMessageIdForHeader(raw: string | undefined | null): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed || /[\s,{}\[\]"]/.test(trimmed)) return undefined;

	const bracketed = trimmed.startsWith("<") && trimmed.endsWith(">");
	const inner = bracketed ? trimmed.slice(1, -1).trim() : trimmed;
	if (!inner || /[<>{}\[\]",\s]/.test(inner)) return undefined;
	if (!bracketed && uuidLike(inner)) return undefined;
	if (!bracketed && !inner.includes("@")) return undefined;

	return `<${inner}>`;
}

export function parseReferencesHeader(raw: string | undefined | null): string[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (!trimmed || /[\[\]{}",]/.test(trimmed)) return [];

	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of trimmed.match(/<[^>]+>|[^\s]+/g) ?? []) {
		const id = normalizeMessageIdForHeader(token);
		if (!id) continue;
		const key = keyForMessageId(id);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(id);
	}
	return out;
}

export function compileReferences(parentReferences: string | undefined | null, parentMessageId: string): string | undefined {
	const parent = normalizeMessageIdForHeader(parentMessageId);
	if (!parent) return undefined;

	const refs = parseReferencesHeader(parentReferences);
	const seen = new Set(refs.map(keyForMessageId));
	const parentKey = keyForMessageId(parent);
	if (!seen.has(parentKey)) refs.push(parent);
	return refs.join(" ");
}

export function buildReplyThreadHeaders(
	parentMessageId: string | undefined | null,
	parentReferences?: string | null,
): EmailReplyThreadHeaders {
	const inReplyTo = normalizeMessageIdForHeader(parentMessageId);
	if (!inReplyTo) return {};
	return {
		in_reply_to: inReplyTo,
		references: compileReferences(parentReferences, inReplyTo),
	};
}
