import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface DomainToolOptions {
	authToken?: string;
	brokerUrl?: string;
}

function brokerBase(options: DomainToolOptions): string {
	return (options.brokerUrl || process.env.DOMAIN_BROKER_URL || "https://domains.example.com").replace(/\/+$/, "");
}

async function brokerRequest(options: DomainToolOptions, path: string, init: RequestInit = {}): Promise<string> {
	const token = options.authToken || process.env.FAT_TOOLS_TOKEN;
	if (!token) throw new Error("Domain tools require FAT_TOOLS_TOKEN.");

	const resp = await fetch(`${brokerBase(options)}${path}`, {
		...init,
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers || {}),
		},
	});

	const contentType = resp.headers.get("Content-Type") || "";
	const text = await resp.text();
	if (!resp.ok) {
		throw new Error(text || `Domain broker request failed with HTTP ${resp.status}`);
	}
	if (contentType.includes("application/json")) {
		return JSON.stringify(JSON.parse(text), null, 2);
	}
	return text;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text: text || "(empty response)" }], details: undefined };
}

export function createDomainToolDefinitions(options: DomainToolOptions = {}): ToolDefinition<any>[] {
	const token = options.authToken || process.env.FAT_TOOLS_TOKEN;
	if (!token) return [];

	return [
		defineTool({
			name: "domain_list",
			label: "domain_list",
			description: "List domains this agent can manage through TinyFat DNS custody.",
			parameters: Type.Object({}),
			execute: async () => textResult(await brokerRequest(options, "/domains", { method: "GET" })),
		}),
		defineTool({
			name: "domain_onboard_prepare",
			label: "domain_onboard_prepare",
			description: "Prepare DNS custody for an existing customer-owned domain. This creates/loads a Cloudflare DNS zone and returns nameserver instructions. It does not transfer registrar billing.",
			parameters: Type.Object({
				domain: Type.String({ description: "Apex domain to manage, for example example.com" }),
				siteTenant: Type.Optional(Type.String({ description: "Optional TinyFat site tenant/script name to associate with this domain." })),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { domain?: string; siteTenant?: string };
				return textResult(await brokerRequest(options, "/domains/onboard/prepare", {
					method: "POST",
					body: JSON.stringify({ domain: body.domain, siteTenant: body.siteTenant }),
				}));
			},
		}),
		defineTool({
			name: "domain_onboard_status",
			label: "domain_onboard_status",
			description: "Check whether a managed domain's Cloudflare zone is active after nameserver delegation.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
			}),
			execute: async (_id: string, input: unknown) => {
				const { domain } = input as { domain?: string };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(domain || "")}/status`, { method: "GET" }));
			},
		}),
		defineTool({
			name: "dns_records_list",
			label: "dns_records_list",
			description: "List DNS records for a TinyFat-managed domain.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
			}),
			execute: async (_id: string, input: unknown) => {
				const { domain } = input as { domain?: string };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(domain || "")}/records`, { method: "GET" }));
			},
		}),
		defineTool({
			name: "dns_snapshot_create",
			label: "dns_snapshot_create",
			description: "Create a DNS snapshot before a risky change or as a manual checkpoint.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
			}),
			execute: async (_id: string, input: unknown) => {
				const { domain } = input as { domain?: string };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(domain || "")}/snapshots`, { method: "POST" }));
			},
		}),
		defineTool({
			name: "dns_change_plan",
			label: "dns_change_plan",
			description: "Plan DNS changes and get a risk/approval decision. Low-risk changes can be applied by ID; high-risk mail/apex/delete changes require explicit approval.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
				summary: Type.Optional(Type.String({ description: "Human-readable reason for the DNS change." })),
				changes: Type.Array(Type.Any(), {
					description: "Array of changes: {op:'create', record:{type,name,content,ttl?,proxied?}}, {op:'update', id, record:{...}}, or {op:'delete', id}.",
				}),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { domain?: string; summary?: string; changes?: unknown[] };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(body.domain || "")}/changes/plan`, {
					method: "POST",
					body: JSON.stringify({ summary: body.summary, changes: body.changes || [] }),
				}));
			},
		}),
		defineTool({
			name: "dns_change_apply",
			label: "dns_change_apply",
			description: "Apply a previously planned low-risk DNS change set. High-risk changes fail until approved outside the agent path.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
				changeSetId: Type.String({ description: "DNS change set id returned by dns_change_plan." }),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { domain?: string; changeSetId?: string };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(body.domain || "")}/changes/${encodeURIComponent(body.changeSetId || "")}/apply`, {
					method: "POST",
				}));
			},
		}),
		defineTool({
			name: "domain_export",
			label: "domain_export",
			description: "Export the current Cloudflare zone file for a TinyFat-managed domain, useful for portability or exit.",
			parameters: Type.Object({
				domain: Type.String({ description: "Managed apex domain, for example example.com" }),
			}),
			execute: async (_id: string, input: unknown) => {
				const { domain } = input as { domain?: string };
				return textResult(await brokerRequest(options, `/domains/${encodeURIComponent(domain || "")}/export`, { method: "POST" }));
			},
		}),
	];
}
