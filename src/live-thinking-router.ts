import { liveThinkingPrompt, type LiveFragment, type LiveThinkingInput } from "./live-thinking-bridge.js";

/** Coalesce while queued; assistant-only speech cannot wake the thinker into a
 * voice→thought→voice feedback loop. A busy runner receives corrections through
 * its existing safe-boundary steering queue, without aborting tools.
 */
export class LiveThinkingRouter {
	private sessions = new Map<string, { pending: LiveFragment[]; sequence: number; queued: boolean; introduced: boolean }>();
	constructor(private readonly target: {
		steer(prompt: string, deliveryId: string): boolean;
		queue(id: string, takePrompt: () => { prompt: string; deliveryId: string } | null): void;
	}) {}
	accept(input: LiveThinkingInput): void {
		let state = this.sessions.get(input.session_id);
		if (!state) {
			// One bridge session is active. Closed-session router state is not
			// retained indefinitely; queued closures keep their own state.
			this.sessions.clear();
			state = { pending: [], sequence: 0, queued: false, introduced: false };
			this.sessions.set(input.session_id, state);
		}
		if (state.pending.length + input.fragments.length > 2000 || state.pending.reduce((n, f) => n + f.text.length, 0) + input.fragments.reduce((n, f) => n + f.text.length, 0) > 100000) throw new Error("Live thinking queue capacity exceeded");
		state.pending.push(...input.fragments); state.sequence = input.sequence;
		if (state.queued || !state.pending.some(f => f.role === "room" && f.text.trim())) return;
		const take = () => {
			state!.queued = false;
			if (!state!.pending.length) return null;
			const deliveryId = `live-thinking:${input.session_id}:${state!.sequence}`;
			const prompt = liveThinkingPrompt({ session_id: input.session_id, sequence: state!.sequence, fragments: state!.pending }, !state!.introduced);
			state!.pending = []; state!.introduced = true;
			return { prompt, deliveryId };
		};
		const deliveryId = `live-thinking:${input.session_id}:${state.sequence}`;
		const prompt = liveThinkingPrompt({ session_id: input.session_id, sequence: state.sequence, fragments: state.pending }, !state.introduced);
		if (this.target.steer(prompt, deliveryId)) { take(); return; }
		state.queued = true;
		this.target.queue(input.session_id, take);
	}
}
