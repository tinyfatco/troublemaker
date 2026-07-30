function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function preserveLineBreaks(lines) {
	if (lines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line))) return true;
	return lines.length > 1
		&& lines.length <= 4
		&& lines.every((line) => line.trim().length <= 80)
		&& /[,—]$/.test(lines[0].trim());
}

function paragraphHtml(block) {
	const lines = block.split("\n").map((line) => line.trim());
	const separator = preserveLineBreaks(lines) ? "<br>" : " ";
	return `<p style="margin:0 0 1em 0">${lines.map(escapeHtml).join(separator)}</p>`;
}

export function plainTextEmailHtml(body) {
	const normalized = String(body || "")
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.trimEnd();
	const paragraphs = normalized
		.split(/\n{2,}/)
		.filter((block) => block.trim())
		.map(paragraphHtml)
		.join("");
	return `<!doctype html><html><body style="margin:0;padding:0">${paragraphs}</body></html>`;
}
