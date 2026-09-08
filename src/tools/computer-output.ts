import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { requiredToolLabelSchema, requireNonblankToolLabel } from "./tool-label.js";

// UTF-8 bytes bound even adversarial Unicode and tokenizer-unfriendly output.
export const COMPUTER_OUTPUT_BYTES = 8_192;
const BODY_BYTES = 6_400;
const MAX_STORED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 16;
const TTL_MS = 15 * 60 * 1000;

function clip(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function readable(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed, null, 2).replace(/\\n/g, "\n");
	} catch { /* AX trees are normally already line-oriented. */ }
	return text;
}

interface Entry { text: string; created: number; bytes: number }

/** Per-bridge, ephemeral snapshots. No global cross-workspace data or disk spill. */
export class ComputerOutputStore {
	private entries = new Map<string, Entry>();
	constructor(readonly detailToolName: string, private now: () => number = Date.now) {}

	private prune() {
		for (const [id, entry] of this.entries) {
			if (this.now() - entry.created >= TTL_MS) this.entries.delete(id);
		}
	}

	bound(raw: string): string {
		if (Buffer.byteLength(raw) <= COMPUTER_OUTPUT_BYTES) return raw;
		this.prune();
		const text = readable(raw);
		const bytes = Buffer.byteLength(text);
		let id: string | undefined;
		if (bytes <= MAX_STORED_BYTES) {
			while (this.entries.size && (this.entries.size >= MAX_ENTRIES ||
				[...this.entries.values()].reduce((n, e) => n + e.bytes, 0) + bytes > MAX_STORED_BYTES)) {
				this.entries.delete(this.entries.keys().next().value!);
			}
			id = randomUUID();
			this.entries.set(id, { text, bytes, created: this.now() });
		}
		const lines = text.split("\n");
		// Keep context headers and interactive controls ahead of long document text.
		// Preserve original order, source line numbers, and element IDs verbatim.
		const ranked = lines.map((line, index) => ({ line, index, rank:
			index < 16 ? 0 : /\b(app(?:lication)?|window|focused|selected|url|error|snapshot)\b\s*[:=]/i.test(line) ? 1 :
			/\b(button|textfield|text field|combobox|checkbox|menuitem|toolbar|AXButton|AXTextField)\b/i.test(line) ? 2 : 3,
		})).sort((a, b) => a.rank - b.rank || a.index - b.index);
		let used = 0;
		const selected: Array<{ index: number; text: string }> = [];
		for (const item of ranked) {
			const short = clip(item.line, 320);
			const line = `L${item.index + 1}: ${short}${short !== item.line ? " … [line truncated]" : ""}\n`;
			const size = Buffer.byteLength(line);
			if (used + size > BODY_BYTES) continue;
			selected.push({ index: item.index, text: line }); used += size;
		}
		const notice = `[COMPUTER OUTPUT TRUNCATED: ${Buffer.byteLength(raw)} original bytes; ${lines.length} source lines. ` +
			`Only selected lines/previews follow; omitted text is not evidence of absent elements. ` +
			(id ? `Read more without repeating the action: ${this.detailToolName}({result_id:"${id}",start_line:1,query:"optional element ID or text"}). ` +
				`Snapshot expires after 15 minutes or cache eviction/restart; IDs describe this snapshot, not guaranteed current UI.` :
				"Full output exceeded the 32 MiB snapshot limit and was not retained. Request a narrower app/window/element observation.") + "]\n";
		return clip(notice + selected.sort((a, b) => a.index - b.index).map((s) => s.text).join(""), COMPUTER_OUTPUT_BYTES);
	}

	read(id: string, startLine = 1, query?: string, column = 0): string {
		this.prune();
		const entry = this.entries.get(id);
		if (!entry) return "Snapshot unavailable (expired, evicted, or runtime restarted). Request fresh, narrower state; do not repeat a side-effecting action merely to retrieve its output.";
		if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(column) || column < 0) return "start_line must be a positive integer; column must be a nonnegative integer.";
		const lines = entry.text.split("\n");
		let index = startLine - 1;
		if (query) {
			const match = lines.findIndex((line, i) => i >= index && line.toLowerCase().includes(query.toLowerCase()));
			if (match < 0) return `No matching source line at or after ${startLine}. Snapshot may be stale.`;
			index = match;
			if (!column) column = Math.max(0, lines[index].toLowerCase().indexOf(query.toLowerCase()) - 120);
		}
		let body = "";
		let nextColumn = column;
		for (; index < lines.length; index++) {
			const remaining = lines[index].slice(nextColumn);
			const prefix = `L${index + 1}${nextColumn ? ` column ${nextColumn}` : ""}: `;
			const room = BODY_BYTES - Buffer.byteLength(body + prefix) - 1;
			if (room <= 0) break;
			const part = clip(remaining, room);
			body += prefix + part + "\n";
			if (part !== remaining) { nextColumn += part.length; break; }
			nextColumn = 0;
		}
		const continuation = index < lines.length
			? `More detail: ${this.detailToolName}({result_id:"${id}",start_line:${index + 1},column:${nextColumn}}). Omit query to continue sequentially.`
			: "End of snapshot.";
		return clip(`[Stored computer observation; source line numbers; snapshot IDs may now be stale.]\n${body}\n${continuation}`, COMPUTER_OUTPUT_BYTES);
	}

	tool(): AgentTool<any> {
		return {
			name: this.detailToolName, label: "Read computer output detail",
			description: "Read bounded detail from a truncated computer-use result without executing the action again. Use query to locate an element ID or text, then paginate using returned source line and column. Observations can be stale; acquire fresh state before acting when necessary.",
			parameters: Type.Object({
				label: requiredToolLabelSchema("Brief reason for inspecting detail"),
				result_id: Type.String(), start_line: Type.Optional(Type.Integer({ minimum: 1 })),
				column: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String({ maxLength: 256 })),
			}),
			execute: async (_id, args) => {
				requireNonblankToolLabel(args, this.detailToolName);
				const input = args as { result_id: string; start_line?: number; query?: string; column?: number };
				return { content: [{ type: "text", text: this.read(input.result_id, input.start_line, input.query, input.column) }], details: undefined };
			},
		};
	}
}
