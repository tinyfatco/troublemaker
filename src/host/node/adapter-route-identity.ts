export const DISPATCH_PATHS: Readonly<Record<string, string>> = Object.freeze({
	"slack:webhook": "/slack/events",
	"telegram:webhook": "/telegram/webhook",
	"discord:webhook": "/discord/interactions",
	"email:webhook": "/email/inbound",
	"mattermost:webhook": "/mattermost/inbound",
	"rocket-chat:webhook": "/rocketchat/inbound",
	"rocketchat:webhook": "/rocketchat/inbound",
	"zulip:webhook": "/zulip/inbound",
	"phone-messaging:webhook": "/phone-messaging/webhook",
	"phone:webhook": "/phone-messaging/webhook",
	"form:webhook": "/form/webhook",
	web: "/web/chat",
	mcp: "/mcp",
});

/**
 * Preserve the configured identity of each adapter independently of its later
 * position in the runtime adapter list. Implicit adapters may be inserted or
 * appended without changing route ownership for configured adapters.
 */
export function indexAdaptersByIdentity<T extends object>(
	identities: readonly string[],
	adapters: readonly T[],
): ReadonlyMap<T, string> {
	if (identities.length !== adapters.length) {
		throw new Error("Adapter identities and instances must have matching lengths");
	}

	const identityByAdapter = new Map<T, string>();
	for (let index = 0; index < adapters.length; index++) {
		const adapter = adapters[index];
		if (identityByAdapter.has(adapter)) {
			throw new Error("Each configured adapter instance must be unique");
		}
		identityByAdapter.set(adapter, identities[index]);
	}
	return identityByAdapter;
}

export function dispatchPathForAdapter<T extends object>(
	adapter: T,
	identityByAdapter: ReadonlyMap<T, string>,
): string | undefined {
	const identity = identityByAdapter.get(adapter);
	return identity === undefined ? undefined : DISPATCH_PATHS[identity];
}
