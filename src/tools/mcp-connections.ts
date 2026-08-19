import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface McpConnectionToolOptions {
	baseUrl?: string;
	token?: string;
	contextId?: string;
	fetch?: typeof fetch;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text: text || "(empty response)" }], details: undefined };
}

async function hostRequest(options: McpConnectionToolOptions, body: Record<string, unknown>): Promise<string> {
	const baseUrl = (options.baseUrl || process.env.TROUBLEMAKER_HOSTD_URL || "").replace(/\/+$/, "");
	const token = options.token || process.env.MOM_MCP_CONTROL_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) {
		throw new Error("MCP connections require the Hostd URL, context, and scoped capability.");
	}
	const request = options.fetch || fetch;
	const response = await request(`${baseUrl}/v1/mcp/control`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ context_id: contextId, ...body }),
	});
	const responseText = await response.text();
	if (!response.ok) {
		let reason = responseText;
		try {
			const parsed = JSON.parse(responseText) as { error?: unknown };
			if (typeof parsed.error === "string") reason = parsed.error;
		} catch {
			// Preserve the bounded host response when it is not JSON.
		}
		throw new Error(`MCP connection request failed (${response.status}): ${reason.slice(0, 300)}`);
	}
	try {
		return JSON.stringify(JSON.parse(responseText), null, 2);
	} catch {
		throw new Error("MCP connection host returned invalid JSON.");
	}
}

export function createMcpConnectionToolDefinitions(
	options: McpConnectionToolOptions = {},
): ToolDefinition<any>[] {
	const baseUrl = options.baseUrl || process.env.TROUBLEMAKER_HOSTD_URL;
	const token = options.token || process.env.MOM_MCP_CONTROL_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) return [];

	return [defineTool({
		name: "mcp_connection",
		label: "mcp_connection",
		description: "Request a one-time human handoff for an MCP connection instead of asking anyone to paste a credential into chat, list this relationship's connections, or revoke one. The request fails unless this Hostd context has exactly one verified durable relationship. Inbound exposes only instruct_operator for that exact Relationship Operator; it never exposes shell, files, channels, recipient selection, or direct sending. Outbound projects a remote MCP only into that same relationship context while Hostd keeps its credential outside the runtime.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("request"),
				Type.Literal("list"),
				Type.Literal("revoke"),
			]),
			direction: Type.Optional(Type.Union([
				Type.Literal("handoff"),
				Type.Literal("inbound"),
				Type.Literal("outbound"),
			])),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
			server_url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
			id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		}),
		execute: async (_id: string, input: unknown) => {
			const body = input as {
				action?: string;
				direction?: string;
				name?: string;
				server_url?: string;
				id?: string;
			};
			if (body.action === "request") {
				if (!["inbound", "outbound"].includes(body.direction || "")) {
					throw new Error("Requesting an MCP connection requires an inbound or outbound direction.");
				}
				return textResult(await hostRequest(options, {
					action: "request",
					direction: body.direction,
					name: body.name || "MCP connection",
					...(body.server_url ? { server_url: body.server_url } : {}),
				}));
			}
			if (body.action === "list") {
				return textResult(await hostRequest(options, { action: "list" }));
			}
			if (body.action === "revoke") {
				if (!body.id || !["handoff", "inbound", "outbound"].includes(body.direction || "")) {
					throw new Error("Revoking MCP access requires its id and handoff/inbound/outbound direction.");
				}
				return textResult(await hostRequest(options, {
					action: "revoke",
					direction: body.direction,
					id: body.id,
				}));
			}
			throw new Error("MCP connection action must be request, list, or revoke.");
		},
	})];
}
