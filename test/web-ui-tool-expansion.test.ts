import {
	isToolDetailsExpanded,
	shouldAutoCollapseToolDetails,
	shouldAutoOpenToolDetails,
	TOOL_AUTO_COLLAPSE_DELAY_MS,
} from "../ui/src/toolExpansion.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

assert(shouldAutoOpenToolDetails(true, true), "running tool with details auto-opens");
assert(!shouldAutoOpenToolDetails(false, true), "running tool without visible details stays collapsed");
assert(!shouldAutoOpenToolDetails(true, false), "settled tool does not auto-open from scratch");
assert(!shouldAutoCollapseToolDetails(true, false, false), "auto-opened tool stays visible until its stream requests collapse");
assert(shouldAutoCollapseToolDetails(true, false, true), "auto-opened tool schedules collapse after the completion request");
assert(!shouldAutoCollapseToolDetails(false, false), "manual-only open does not auto-collapse");
assert(isToolDetailsExpanded(true, false, true), "auto-open state expands details");
assert(isToolDetailsExpanded(true, true, false), "manual-open state expands details");
assert(!isToolDetailsExpanded(false, true, true), "tools without details remain collapsed");
assert(TOOL_AUTO_COLLAPSE_DELAY_MS > 0, "auto-collapse keeps a visible completion beat");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
