export interface WorkspaceEntry {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	modified?: string;
}

/**
 * Portable workspace file contract.
 *
 * Node backs this with POSIX fs. Crawdad CF can back the same shape with
 * encrypted R2/gocryptfs reads and DO-serialized writes.
 */
export interface WorkspaceStore {
	exists(path: string): boolean;
	readText(path: string): string | null;
	readBytes(path: string): Uint8Array | null;
	writeText(path: string, content: string): void;
	writeBytes(path: string, content: Uint8Array): void;
	list(path: string): WorkspaceEntry[];
	stat(path: string): { type: "file" | "directory"; size: number; modified: string } | null;
	mtimeMs(path: string): number;
	resolvePath(path: string): string;
}
