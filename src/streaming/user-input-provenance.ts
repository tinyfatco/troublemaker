import { readVerifiedSenderIdentity, type VerifiedSenderIdentity } from "../sender-identity.js";
import { parseVisibleUserInputs, type VisibleUserInput } from "../user-input-display.js";

interface PendingInput {
	prompt: string;
	sender?: VerifiedSenderIdentity;
}

export function projectVerifiedUserInputs(prompt: string, senderIdentity?: VerifiedSenderIdentity): VisibleUserInput[] {
	const entries = parseVisibleUserInputs(prompt);
	const sender = readVerifiedSenderIdentity(senderIdentity);
	if (entries.length === 1 && sender?.userName === entries[0].userName) {
		entries[0] = { ...entries[0], userId: sender.userId, displayName: sender.displayName };
	}
	return entries;
}

/**
 * Bind an ingress snapshot to the exact submitted user message before Pi saves
 * it. Metadata stays outside model text; matching names or body fragments cannot
 * confer identity. Each queue entry is consumed once, including unnamed inputs.
 */
export class UserInputProvenance {
	private readonly pending: PendingInput[] = [];

	track(prompt: string, sender?: VerifiedSenderIdentity): () => void {
		const input = { prompt, sender: readVerifiedSenderIdentity(sender) };
		this.pending.push(input);
		return () => {
			const index = this.pending.indexOf(input);
			if (index !== -1) this.pending.splice(index, 1);
		};
	}

	/** Called synchronously at message_start, before SessionManager persistence. */
	apply(message: { role: string; content: unknown; senderIdentity?: VerifiedSenderIdentity }): VisibleUserInput[] {
		if (message.role !== "user") return [];
		const content = message.content;
		const prompt = typeof content === "string" ? content : Array.isArray(content)
			? content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")
			: "";
		const entries = parseVisibleUserInputs(prompt);
		const index = this.pending.findIndex((input) => input.prompt === prompt);
		const input = index === -1 ? undefined : this.pending.splice(index, 1)[0];
		delete message.senderIdentity;
		if (entries.length === 1 && input?.sender?.userName === entries[0].userName) {
			message.senderIdentity = { ...input.sender };
			entries[0] = { ...entries[0], userId: input.sender.userId, displayName: input.sender.displayName };
		}
		return entries;
	}

	clear(): void {
		this.pending.length = 0;
	}
}
