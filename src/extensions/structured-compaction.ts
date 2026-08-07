import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const STRUCTURED_COMPACTION_SCHEMA_VERSION = 1;

export function parseStructuredCheckpoint(text: string): Record<string, unknown> | null {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(trimmed.slice(start, end + 1));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		if ((parsed as Record<string, unknown>).schemaVersion !== STRUCTURED_COMPACTION_SCHEMA_VERSION) return null;
		if (!(parsed as Record<string, unknown>).durableState || typeof (parsed as Record<string, unknown>).durableState !== "object") return null;
		if (typeof (parsed as Record<string, unknown>).narrative !== "string") return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

export default function structuredCompactionExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

		const { preparation, reason, customInstructions, signal } = event;
		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const conversation = serializeConversation(convertToLlm(messages));
		const previous = preparation.previousSummary
			? `\n<previous-checkpoint>\n${preparation.previousSummary}\n</previous-checkpoint>`
			: "";
		const additional = customInstructions?.trim()
			? `\nAdditional owner focus: ${customInstructions.trim()}`
			: "";

		const prompt = `Create a compact, provenance-bearing checkpoint for an agent runtime. Return ONLY valid JSON with this exact top-level shape:
{
  "schemaVersion": 1,
  "durableState": {
    "goals": [],
    "constraints": [],
    "decisions": [],
    "completed": [],
    "pending": [],
    "blockers": [],
    "artifacts": [],
    "uncertainties": [],
    "superseded": []
  },
  "narrative": ""
}

Rules:
- Each durable item must be a short object with at least "text" and, when known, "source" and "status".
- Distinguish owner instructions, independently verified facts, agent-attributed claims, and hypotheses.
- Preserve exact commit IDs, paths, receipt IDs, timestamps, targets, errors, and negative constraints when material.
- Move replaced facts to "superseded"; never silently keep contradictory old state active.
- Keep unresolved unknowns in "uncertainties"; never upgrade accepted/sent/claimed into completed or verified.
- Do not copy reasoning, secrets, credentials, private message bodies, or large tool output.
- "narrative" is a concise continuity paragraph, not a duplicate of durableState.
- Update the previous checkpoint rather than recursively repeating it.
- Keep the entire JSON under 32,000 characters.${additional}

Compaction reason: ${reason}${previous}

<conversation>
${conversation}
</conversation>`;

		try {
			const response = await complete(
				model,
				{
					systemPrompt: "You create strict JSON state checkpoints for a long-running agent. Preserve authority, provenance, supersession, and uncertainty.",
					messages: [{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					}],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: 8192,
					signal,
				},
			);
			if (response.stopReason === "error") return;
			const text = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const checkpoint = parseStructuredCheckpoint(text);
			if (!checkpoint) return;
			const summary = JSON.stringify(checkpoint, null, 2);
			if (summary.length > 32_000) return;

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {
						schemaVersion: STRUCTURED_COMPACTION_SCHEMA_VERSION,
						reason,
						isSplitTurn: preparation.isSplitTurn,
					},
				},
			};
		} catch {
			// Fail open to Pi's built-in compaction when custom summarization or
			// validation fails. Losing the checkpoint is worse than losing the shape.
			return;
		}
	});
}
