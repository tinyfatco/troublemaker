import { createHash } from "crypto";

export type SessionContextSections = Record<string, string>;

export interface SessionContextProjection {
	text: string;
	hash: string;
	mode: "full" | "delta" | "reference";
	changedSections: string[];
}

function digestSections(sections: SessionContextSections): string {
	const canonical = Object.keys(sections)
		.sort()
		.map((key) => `${key.length}:${key}:${sections[key].length}:${sections[key]}`)
		.join("\0");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function renderSection(name: string, value: string): string {
	if (name === "Attending") return `Attending: ${value || "(none)"}`;
	return `${name}:\n${value || "(none)"}`;
}

/**
 * Emit a complete session context once per runner, then only changed sections.
 * The prior full context remains in the model transcript, so unchanged blocks
 * are referenced by content hash instead of being appended again.
 */
export class SessionContextProjector {
	private previous: SessionContextSections | null = null;
	private previousHash: string | null = null;

	project(sections: SessionContextSections): SessionContextProjection {
		const snapshot = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value ?? ""]));
		const hash = digestSections(snapshot);

		if (!this.previous || !this.previousHash) {
			this.previous = snapshot;
			this.previousHash = hash;
			return {
				text: `<session_context hash="${hash}">\n${Object.entries(snapshot).map(([key, value]) => renderSection(key, value)).join("\n\n")}\n</session_context>`,
				hash,
				mode: "full",
				changedSections: Object.keys(snapshot),
			};
		}

		const changedSections = Array.from(new Set([...Object.keys(this.previous), ...Object.keys(snapshot)]))
			.filter((key) => this.previous?.[key] !== snapshot[key]);
		const base = this.previousHash;
		this.previous = snapshot;
		this.previousHash = hash;

		if (changedSections.length === 0) {
			return {
				text: `<session_context_ref hash="${hash}">Unchanged; use the prior session_context with this hash.</session_context_ref>`,
				hash,
				mode: "reference",
				changedSections,
			};
		}

		return {
			text: `<session_context_delta base="${base}" hash="${hash}">\nReplace only these sections from the prior session_context:\n\n${changedSections.map((key) => renderSection(key, snapshot[key])).join("\n\n")}\n</session_context_delta>`,
			hash,
			mode: "delta",
			changedSections,
		};
	}

	reset(): void {
		this.previous = null;
		this.previousHash = null;
	}
}
