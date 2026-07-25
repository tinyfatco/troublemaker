import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

const root = process.cwd();
const eventModule = readFileSync(join(root, 'ui/src/webChatTurnEvents.ts'), 'utf8');
const webChat = readFileSync(join(root, 'ui/src/hooks/useWebChat.ts'), 'utf8');
const awareness = readFileSync(join(root, 'ui/src/hooks/useAwarenessStream.ts'), 'utf8');

assert(
	eventModule.includes("WEB_CHAT_TURN_COMPLETE_EVENT = 'tinyfat:web-chat-turn-complete'"),
	'web chat turn completion event has a stable shared name',
);

assert(
	webChat.includes("import { WEB_CHAT_TURN_COMPLETE_EVENT } from '../webChatTurnEvents'"),
	'useWebChat imports the shared completion event',
);

assert(
	webChat.includes('window.dispatchEvent(new CustomEvent(WEB_CHAT_TURN_COMPLETE_EVENT'),
	'useWebChat dispatches the completion event after a normal turn settles',
);

assert(
	webChat.indexOf('window.dispatchEvent(new CustomEvent(WEB_CHAT_TURN_COMPLETE_EVENT') <
		webChat.indexOf('if (!active) return'),
	'useWebChat dispatches the completion event before the stale-request guard',
);

assert(
	webChat.indexOf('preserveActiveTurnBeforeReplacement();') <
		webChat.indexOf("activateStreamingEntry('steering'"),
	'useWebChat preserves the active turn before a steering request replaces it',
);

assert(
	awareness.includes("import { WEB_CHAT_TURN_COMPLETE_EVENT } from '../webChatTurnEvents'"),
	'useAwarenessStream imports the shared completion event',
);

assert(
	awareness.includes('window.addEventListener(WEB_CHAT_TURN_COMPLETE_EVENT, refreshAfterWebChatTurn)') &&
		awareness.includes('refreshRecentBacklog(false).catch(() => {})'),
	'useAwarenessStream refreshes recent durable backlog after a web chat turn completes',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
