export interface EdgeTextStorage {
	readText(path: string): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
}

export async function readJsonFile<T>(
	storage: Pick<EdgeTextStorage, "readText">,
	path: string,
	fallback: T,
): Promise<T> {
	try {
		const raw = await storage.readText(path);
		if (!raw.trim()) return fallback;
		return JSON.parse(raw) as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("File not found")) return fallback;
		throw err;
	}
}

export async function writeJsonFile<T>(
	storage: Pick<EdgeTextStorage, "writeText">,
	path: string,
	value: T,
): Promise<void> {
	await storage.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}
