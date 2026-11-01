import {
	isToolDetailsExpanded,
	shouldAutoCollapseToolDetails,
	shouldAutoOpenToolDetails,
	shouldStickToolOutputToBottom,
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
assert(shouldAutoCollapseToolDetails(true, false, true), "auto-opened tool collapses after its scheduled completion beat");
assert(!shouldAutoCollapseToolDetails(false, false), "manual-only open does not auto-collapse");
assert(isToolDetailsExpanded(true, false, true), "auto-open state expands details");
assert(isToolDetailsExpanded(true, true, false), "manual-open state expands details");
assert(!isToolDetailsExpanded(false, true, true), "tools without details remain collapsed");
assert(TOOL_AUTO_COLLAPSE_DELAY_MS > 0, "auto-collapse keeps a visible completion beat");
assert(shouldStickToolOutputToBottom(1000, 740, 260), "output box at its bottom keeps following new lines");
assert(shouldStickToolOutputToBottom(1000, 730, 260), "a few pixels short of the bottom still follows");
assert(!shouldStickToolOutputToBottom(1000, 400, 260), "reader who scrolled up inside the output box is left alone");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
