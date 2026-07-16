import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceContext } from "../src/core/prompt.js";
import { readGoalState } from "../src/goal-state.js";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.js";
import { createAbandonGoalTool } from "../src/tools/abandon-goal.js";
import { createCompleteGoalTool } from "../src/tools/complete-goal.js";
import { createSetGoalTool } from "../src/tools/set-goal.js";
import { enforceRequiredToolLabels } from "../src/tools/tool-label.js";

function resultText(result: any): string {
	return result.content?.[0]?.text || "";
}

const workingDir = await mkdtemp(join(tmpdir(), "troublemaker-goal-tools-"));
try {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	const [setGoal, completeGoal, abandonGoal] = enforceRequiredToolLabels([
		createSetGoalTool(workingDir),
		createCompleteGoalTool(workingDir),
		createAbandonGoalTool(workingDir),
	]);

	const setResult = await (setGoal.execute as any)("set-1", {
		label: "Keep the launch objective active",
		goal: "Ship persistent Troublemaker goals",
	});
	assert.equal(resultText(setResult), "Set active goal: Ship persistent Troublemaker goals");
	assert.equal(readGoalState(workspace)?.status, "active");
	assert.match(getWorkspaceContext(workspace), /Current goal \[ACTIVE\]: Ship persistent Troublemaker goals/);
	assert.match(getWorkspaceContext(workspace), /Persist toward this goal until it is complete/);

	const completeResult = await (completeGoal.execute as any)("complete-1", {
		label: "Close the achieved launch objective",
	});
	assert.equal(resultText(completeResult), "Completed goal: Ship persistent Troublemaker goals");
	assert.equal(readGoalState(workspace)?.status, "completed");
	assert.doesNotMatch(getWorkspaceContext(workspace), /Current goal \[ACTIVE\]/);

	await (setGoal.execute as any)("set-2", {
		label: "Track a replacement objective",
		goal: "Draft a superseded rollout",
	});
	const abandonResult = await (abandonGoal.execute as any)("abandon-1", {
		label: "Drop the superseded objective",
		reason: "User redirected the rollout",
	});
	assert.equal(resultText(abandonResult), "Abandoned goal: Draft a superseded rollout (User redirected the rollout)");
	assert.equal(readGoalState(workspace)?.status, "abandoned");
	assert.equal(readGoalState(workspace)?.reason, "User redirected the rollout");

	await assert.rejects(
		() => (setGoal.execute as any)("set-3", { label: "Reject an empty objective", goal: "   " }),
		/non-empty goal/,
	);
	await assert.rejects(
		() => (setGoal.execute as any)("set-4", { goal: "Missing the required presentation label" }),
		/requires a nonblank label/,
	);

	console.log("goal tools: ok");
} finally {
	await rm(workingDir, { recursive: true, force: true });
}
