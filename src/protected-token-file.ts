import { readFileSync, statSync } from "fs";
import { isAbsolute } from "path";

export function readProtectedTokenFile(filePath: string | undefined): string | undefined {
	const normalized = filePath?.trim();
	if (!normalized) return undefined;
	if (!isAbsolute(normalized)) {
		throw new Error("Protected token file path must be absolute");
	}

	const stat = statSync(normalized);
	if (!stat.isFile()) {
		throw new Error(`Protected token path is not a regular file: ${normalized}`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(`Protected token file must not be accessible by group or others: ${normalized}`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`Protected token file must be owned by the runtime user: ${normalized}`);
	}

	const token = readFileSync(normalized, "utf8").trim();
	if (!token) {
		throw new Error(`Protected token file is empty: ${normalized}`);
	}
	return token;
}
