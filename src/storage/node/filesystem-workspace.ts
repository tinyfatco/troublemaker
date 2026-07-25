import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "fs";
import { dirname, join, normalize, resolve } from "path";
import type { WorkspaceEntry, WorkspaceStore } from "../workspace.js";

export class FilesystemWorkspaceStore implements WorkspaceStore {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	exists(path: string): boolean {
		return existsSync(this.resolvePath(path));
	}

	readText(path: string): string | null {
		try {
			return readFileSync(this.resolvePath(path), "utf-8");
		} catch {
			return null;
		}
	}

	readBytes(path: string): Uint8Array | null {
		try {
			return readFileSync(this.resolvePath(path));
		} catch {
			return null;
		}
	}

	writeText(path: string, content: string): void {
		const fullPath = this.resolvePath(path);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content, "utf-8");
	}

	writeBytes(path: string, content: Uint8Array): void {
		const fullPath = this.resolvePath(path);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}

	list(path: string): WorkspaceEntry[] {
		const fullPath = this.resolvePath(path);
		const entries = readdirSync(fullPath, { withFileTypes: true });
		return entries.map((entry) => {
			const relPath = join(path, entry.name);
			const entryFullPath = join(fullPath, entry.name);
			const isDir = entry.isDirectory();
			const result: WorkspaceEntry = {
				name: entry.name,
				path: relPath,
				type: isDir ? "directory" : "file",
			};
			if (!isDir) {
				try {
					const s = statSync(entryFullPath);
					result.size = s.size;
					result.modified = s.mtime.toISOString();
				} catch {
					// Best effort metadata.
				}
			}
			return result;
		});
	}

	stat(path: string): { type: "file" | "directory"; size: number; modified: string } | null {
		try {
			const s = statSync(this.resolvePath(path));
			return {
				type: s.isDirectory() ? "directory" : "file",
				size: s.size,
				modified: s.mtime.toISOString(),
			};
		} catch {
			return null;
		}
	}

	mtimeMs(path: string): number {
		try {
			return statSync(this.resolvePath(path)).mtimeMs;
		} catch {
			return 0;
		}
	}

	resolvePath(path: string): string {
		const fullPath = resolve(this.root, path);
		const normalizedRoot = normalize(this.root);
		if (fullPath !== normalizedRoot && !fullPath.startsWith(`${normalizedRoot}/`)) {
			throw new Error(`Path outside workspace: ${path}`);
		}
		return fullPath;
	}
}
