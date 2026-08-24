export interface ConfiguredAdapterSet<T> {
	identities: string[];
	adapters: T[];
}

export function instantiateConfiguredAdapters<T>(
	identities: readonly string[],
	create: (identity: string) => T,
	isOptional: (identity: string) => boolean,
	onDisabled: (identity: string, error: unknown) => void,
): ConfiguredAdapterSet<T> {
	const enabledIdentities: string[] = [];
	const adapters: T[] = [];
	for (const identity of identities) {
		try {
			adapters.push(create(identity));
			enabledIdentities.push(identity);
		} catch (error) {
			if (!isOptional(identity)) throw error;
			onDisabled(identity, error);
		}
	}
	return { identities: enabledIdentities, adapters };
}
