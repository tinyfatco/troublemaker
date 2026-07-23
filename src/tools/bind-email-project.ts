import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const schema = Type.Object({
	provider_thread_id: Type.String({
		description: "The native Gmail thread ID shown in the current inbound email context.",
		minLength: 1,
		maxLength: 256,
		pattern: "^[A-Za-z0-9_-]+$",
	}),
	project_slug: Type.String({
		description: "A short, stable lowercase slug for this customer's project, such as company-website.",
		minLength: 1,
		maxLength: 63,
		pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
	}),
	project_name: Type.Optional(Type.String({
		description: "A concise human-readable project name.",
		minLength: 1,
		maxLength: 160,
	})),
});

interface BindProjectEnvironment {
	[key: string]: string | undefined;
	TROUBLEMAKER_HOSTD_URL?: string;
	TROUBLEMAKER_CONTEXT_ID?: string;
	MOM_EMAIL_TOOLS_TOKEN?: string;
}

export function createBindEmailProjectTool(
	environment: BindProjectEnvironment = process.env,
	fetchImplementation: typeof fetch = fetch,
): AgentTool<typeof schema> | null {
	const hostUrl = environment.TROUBLEMAKER_HOSTD_URL?.trim();
	const contextId = environment.TROUBLEMAKER_CONTEXT_ID?.trim();
	const token = environment.MOM_EMAIL_TOOLS_TOKEN?.trim();
	if (!hostUrl || !contextId || !token) return null;

	const endpoint = new URL("/v1/context/bind-project", hostUrl).toString();
	return {
		name: "bind_email_project",
		label: "bind_email_project",
		description:
			"Associate the current native Gmail thread with a project inside this sender's private scope. Use this once the project is unambiguous. The binding affects future turns; it never grants access to another sender or project.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const input = params as {
				provider_thread_id?: unknown;
				project_slug?: unknown;
				project_name?: unknown;
			};
			const providerThreadId = requiredText(input.provider_thread_id, "provider_thread_id");
			const projectSlug = requiredText(input.project_slug, "project_slug").toLowerCase();
			if (!/^[A-Za-z0-9_-]+$/.test(providerThreadId)) {
				throw new Error("provider_thread_id contains unsupported characters.");
			}
			if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectSlug) || projectSlug === "intake") {
				throw new Error("project_slug is invalid or reserved.");
			}
			const projectName = optionalText(input.project_name);
			const response = await fetchImplementation(endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					context_id: contextId,
					provider_thread_id: providerThreadId,
					project_slug: projectSlug,
					...(projectName ? { project_name: projectName } : {}),
				}),
				signal: AbortSignal.timeout(15_000),
			});
			const result = await response.json().catch(() => ({})) as {
				error?: string;
				project?: string;
				context?: string;
				appliesTo?: string;
			};
			if (!response.ok) {
				throw new Error(`Project binding failed (${response.status}): ${result.error || "unknown_error"}`);
			}
			return {
				content: [{
					type: "text" as const,
					text: `Bound this Gmail thread to project "${result.project || projectSlug}". The isolated project context will own future turns.`,
				}],
				details: result,
			};
		},
	};
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
	return value.trim();
}

function optionalText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error("project_name must be non-empty when provided.");
	return value.trim();
}
