import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";

type PlutilRunner = (filePath: string, key: string) => string;

export function readProtectedPlistString(
	filePath: string | undefined,
	key: string | undefined,
	runPlutil: PlutilRunner = runSystemPlutil,
): string | undefined {
	const normalizedPath = filePath?.trim();
	if (!normalizedPath) return undefined;
	if (!isAbsolute(normalizedPath)) {
		throw new Error("Protected property-list path must be absolute");
	}
	const normalizedKey = key?.trim() || "";
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(normalizedKey)) {
		throw new Error("Protected property-list key is invalid");
	}

	let descriptor: number | undefined;
	try {
		descriptor = openSync(normalizedPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) {
			throw new Error(`Protected property-list path is not a regular file: ${normalizedPath}`);
		}
		if ((stat.mode & 0o077) !== 0) {
			throw new Error(`Protected property-list file must not be accessible by group or others: ${normalizedPath}`);
		}
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid) {
			throw new Error(`Protected property-list file must be owned by the runtime user: ${normalizedPath}`);
		}

		const value = runPlutil(normalizedPath, normalizedKey).trim();
		if (!value) throw new Error("Protected property-list value is empty");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(`Protected property-list file must not be a symbolic link: ${normalizedPath}`);
		}
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function runSystemPlutil(filePath: string, key: string): string {
	if (process.platform !== "darwin") {
		throw new Error("Protected property-list storage is available only on macOS");
	}
	try {
		return execFileSync(
			"/usr/bin/plutil",
			["-extract", key, "raw", "-o", "-", filePath],
			{
				encoding: "utf8",
				maxBuffer: 65_536,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		throw new Error("Could not read the protected property-list value");
	}
}
