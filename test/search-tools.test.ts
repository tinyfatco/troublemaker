import assert from "node:assert/strict";
import { createSearchToolsTool, type ToolSearchRegistry } from "../src/tools/search-tools.js";

const activated: string[][] = [];
let activeTools = ["read", "search_tools"];

const registry: ToolSearchRegistry = {
	getActiveToolNames: () => activeTools,
	getAllTools: () => [
		{
			name: "read",
			description: "Read files",
			parameters: { type: "object" },
			sourceInfo: { source: "builtin", path: "<builtin:read>" },
		},
		{
			name: "domain_onboard_prepare",
			description: "Prepare DNS custody for an existing customer-owned domain and return nameserver instructions.",
			parameters: { type: "object", properties: { domain: { type: "string" } } },
			sourceInfo: { source: "inline", path: "<inline:tinyfat-domains>" },
		},
		{
			name: "dns_records_list",
			description: "List DNS records for a TinyFat-managed domain.",
			parameters: { type: "object", properties: { domain: { type: "string" } } },
			sourceInfo: { source: "inline", path: "<inline:tinyfat-domains>" },
		},
	],
	setActiveToolsByName: (names) => {
		activeTools = names;
		activated.push(names);
	},
};

function resultText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
	assert.ok(Array.isArray(content), "tool result should include content");
	assert.equal(content[0]?.type, "text");
	return content[0]?.text || "";
}

const tool = createSearchToolsTool(() => registry);
const result = await tool.execute("test-call-id", { query: "domain dns", limit: 2 });
const data = JSON.parse(resultText(result));

assert.equal(data.ok, true);
assert.deepEqual(
	data.tools.map((entry: { name: string }) => entry.name).sort(),
	["dns_records_list", "domain_onboard_prepare"],
);
assert.deepEqual(activated.at(-1)?.slice().sort(), ["dns_records_list", "domain_onboard_prepare", "read", "search_tools"]);

const noCoreResult = await tool.execute("test-call-id", { query: "read", activate: false });
const noCoreData = JSON.parse(resultText(noCoreResult));
assert.deepEqual(noCoreData.tools, [], "core tools should be hidden by default");

const coreResult = await tool.execute("test-call-id", { query: "read", activate: false, includeCore: true, includeActive: true });
const coreData = JSON.parse(resultText(coreResult));
assert.equal(coreData.tools[0].name, "read", "includeCore should allow core tool discovery");

console.log("search_tools discovery ok");
