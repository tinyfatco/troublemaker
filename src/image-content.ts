const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Validate the raw base64 payload used by pi image content blocks.
 * Data URLs are intentionally rejected here because the provider adapter adds
 * the data:image/... prefix when it builds an OpenAI request.
 */
export function isValidImageBase64(data: unknown): data is string {
	if (typeof data !== "string" || data.length === 0 || data.startsWith("data:")) return false;
	if (data.length % 4 !== 0) return false;
	return BASE64_ALPHABET.test(data);
}
