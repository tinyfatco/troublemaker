import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface SiteDeployToolOptions {
	baseUrl?: string;
	token?: string;
	contextId?: string;
	factoryEnabled?: boolean;
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

async function siteRequest(
	options: SiteDeployToolOptions,
	path: "/v1/sites/create" | "/v1/sites/deploy",
	body: Record<string, unknown>,
): Promise<string> {
	const baseUrl = hostBase(options);
	const token = options.token || process.env.MOM_SITE_DEPLOY_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) {
		throw new Error("Sites tools require the Hostd URL, context, and scoped capability.");
	}
	const request = options.fetch || fetch;
	const response = await request(`${baseUrl}${path}`, {
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

	const factoryEnabled = options.factoryEnabled ?? process.env.MOM_SITE_FACTORY_ENABLED === "1";
	return [
		...(factoryEnabled ? [defineTool({
			name: "site_create",
			label: "site_create",
			description: "Create one new TinyFat preview site inside the current Hostd context's verified user scope. Hostd assigns and persists exact site, project, and deployment-grant identities; no platform credential enters the runtime. This does not deploy content, configure DNS/custom domains, promote production, bill, or delete anything.",
			parameters: Type.Object({
				site: Type.String({ description: "New unique site slug under tinyfat.dev.", minLength: 1, maxLength: 55, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" }),
				display_name: Type.String({ description: "Human-readable site name.", minLength: 1, maxLength: 120 }),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { site?: string; display_name?: string };
				return textResult(await siteRequest(options, "/v1/sites/create", {
					site_slug: body.site,
					display_name: body.display_name,
				}));
			},
		})] : []),
		defineTool({
			name: "site_deploy",
			label: "site_deploy",
			description: "Deploy one workspace-contained build artifact to the current project's checked-out Git-branch preview slot. Hostd derives Git provenance from the clean repository, fixes the site/customer scope, keeps platform credentials outside the runtime, and permits preview only. This tool never promotes production.",
			parameters: Type.Object({
				site: Type.Optional(Type.String({ description: "Exact configured site slug. Required when this context can deploy more than one site.", minLength: 1, maxLength: 55, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" })),
				directory: Type.String({ description: "Workspace-relative build artifact directory.", minLength: 1, maxLength: 240 }),
				branch: Type.String({ description: "Exact Git branch name for the preview slot.", minLength: 1, maxLength: 240 }),
				artifact_kind: Type.Union([
					Type.Literal("static"),
					Type.Literal("worker"),
				], { description: "Static files or a supported Worker artifact bundle." }),
				message: Type.Optional(Type.String({ description: "Short deployment note.", maxLength: 500 })),
			}),
			execute: async (id: string, input: unknown) => {
				const body = input as {
					site?: string;
					directory?: string;
					branch?: string;
					artifact_kind?: string;
					message?: string;
				};
				return textResult(await siteRequest(options, "/v1/sites/deploy", {
					idempotency_key: deployIdempotencyKey(id),
					site_slug: body.site,
					directory: body.directory,
					branch: body.branch,
					artifact_kind: body.artifact_kind,
					message: body.message,
				}));
			},
		}),
	];
}
