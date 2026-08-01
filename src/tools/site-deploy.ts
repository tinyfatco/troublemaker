import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface SiteDeployToolOptions {
	baseUrl?: string;
	token?: string;
	contextId?: string;
	fetch?: typeof fetch;
}

function hostBase(options: SiteDeployToolOptions): string {
	return (options.baseUrl || process.env.TROUBLEMAKER_HOSTD_URL || "").replace(/\/+$/, "");
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text: text || "(empty response)" }], details: undefined };
}

function deployIdempotencyKey(toolCallId: string): string {
	if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 4096) {
		throw new Error("Site deploy requires a bounded provider tool-call ID.");
	}
	return `site_deploy:${createHash("sha256").update(toolCallId, "utf8").digest("hex")}`;
}

async function deployRequest(
	options: SiteDeployToolOptions,
	body: Record<string, unknown>,
): Promise<string> {
	const baseUrl = hostBase(options);
	const token = options.token || process.env.MOM_SITE_DEPLOY_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) {
		throw new Error("Site deploy requires the Hostd URL, context, and scoped capability.");
	}
	const request = options.fetch || fetch;
	const response = await request(`${baseUrl}/v1/sites/deploy`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ context_id: contextId, ...body }),
	});
	const text = await response.text();
	if (!response.ok) {
		let reason = text;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed.error === "string") reason = parsed.error;
		} catch {
			// Keep the bounded Hostd response as the reason.
		}
		throw new Error(`Site deploy failed (${response.status}): ${reason.slice(0, 300)}`);
	}
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		throw new Error("Site deploy host returned invalid JSON.");
	}
}

export function createSiteDeployToolDefinitions(options: SiteDeployToolOptions = {}): ToolDefinition<any>[] {
	const baseUrl = hostBase(options);
	const token = options.token || process.env.MOM_SITE_DEPLOY_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) return [];

	return [
		defineTool({
			name: "site_deploy",
			label: "site_deploy",
			description: "Deploy one workspace-contained build artifact to the current project's Git-branch preview slot. Hostd fixes the site and customer scope, keeps platform credentials outside the runtime, and permits preview only. This tool never promotes production.",
			parameters: Type.Object({
				directory: Type.String({ description: "Workspace-relative build artifact directory.", minLength: 1, maxLength: 240 }),
				branch: Type.String({ description: "Exact Git branch name for the preview slot.", minLength: 1, maxLength: 240 }),
				artifact_kind: Type.Union([
					Type.Literal("static"),
					Type.Literal("worker"),
				], { description: "Static files or a supported Worker artifact bundle." }),
				source_sha: Type.Optional(Type.String({ description: "Immutable source commit SHA when available.", minLength: 7, maxLength: 64 })),
				message: Type.Optional(Type.String({ description: "Short deployment note.", maxLength: 500 })),
			}),
			execute: async (id: string, input: unknown) => {
				const body = input as {
					directory?: string;
					branch?: string;
					artifact_kind?: string;
					source_sha?: string;
					message?: string;
				};
				return textResult(await deployRequest(options, {
					idempotency_key: deployIdempotencyKey(id),
					directory: body.directory,
					branch: body.branch,
					artifact_kind: body.artifact_kind,
					source_sha: body.source_sha,
					message: body.message,
				}));
			},
		}),
	];
}
