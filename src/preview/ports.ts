const RESERVED_PREVIEW_PORTS = new Set([3000, 3002, 6080, 8765, 9222]);

export function isReservedPreviewPort(port: number): boolean {
	return RESERVED_PREVIEW_PORTS.has(port) || (port >= 5900 && port <= 5999);
}

export function validatePreviewPort(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const port = typeof value === "number"
		? value
		: /^\d+$/.test(value.trim())
			? Number.parseInt(value.trim(), 10)
			: Number.NaN;

	if (!Number.isInteger(port) || port < 1024 || port > 65535 || isReservedPreviewPort(port)) {
		return null;
	}

	return port;
}

export function describePreviewPortPolicy(): string {
	return "Preview port must be 1024-65535 and must not be a TinyFat reserved port: 3000, 3002, 6080, 8765, 9222, or 5900-5999";
}
