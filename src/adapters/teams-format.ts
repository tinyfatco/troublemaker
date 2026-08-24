/**
 * Teams supports a useful Markdown subset but not language annotations on
 * fenced code blocks consistently across desktop, mobile, and notifications.
 */
export function markdownToTeams(text: string): string {
	return text.replace(/```[^\n`]*\n/g, "```\n");
}
