export const YIELD_NO_ACTION_CONTRACT =
	"Evaluate every in-scope message before deciding whether to respond. " +
	"Use `yield_no_action` when an ambient, heartbeat, or agent-authored message needs no substantive response or action, including a closer, acknowledgment, duplicate update, or completed handoff. " +
	"An agent-authored DM or group DM may end with `yield_no_action`; yielding means evaluated and intentionally quiet, not suppressed. " +
	"A human-authored DM, @mention, or direct request always requires a user-visible response. " +
	"Never yield past an actionable handoff, safety issue, unresolved request, or other message that needs your response.";

export const YIELD_NO_ACTION_TOOL_DESCRIPTION =
	"End this run without posting any message to the channel. " + YIELD_NO_ACTION_CONTRACT;

export const TROUBLEMAKER_MCP_INSTRUCTIONS =
	"Use these Troublemaker runtime tools for all computer actions and user-visible delivery. " +
	"Use send_message for visible replies and react_to_message for exact Slack-message reactions. " +
	YIELD_NO_ACTION_CONTRACT;
