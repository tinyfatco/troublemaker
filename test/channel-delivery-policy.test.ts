import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSendMessageOnlyPlatform, MomSettingsManager } from "../src/context.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-channel-policy-"));

try {
	const defaults = new MomSettingsManager(join(workingDir, "empty"));
	assert.equal(defaults.getVerbose("C1234567890", "slack"), "messages-only", "Slack keeps its safe default without config");
	assert.equal(defaults.getVerbose("8389147137", "telegram"), "messages-only", "Telegram keeps its safe default without config");
	assert.equal(defaults.getVerbose("1443881334165733493", "discord"), "messages-only", "Discord keeps its safe default without config");
	assert.equal(defaults.getVerbose("email-alex_example_com", "email"), "messages-only", "Email keeps its safe default without config");
	assert.equal(defaults.getVerbose("phone-abc123", "phone"), "messages-only", "Phone keeps its safe default without config");
	assert.equal(defaults.getVerbose("form-abc123", "form"), true, "Form ingress keeps direct harness output by default");
	assert.equal(defaults.getVerbose("web", "web"), true, "Web chat keeps direct harness streaming by default");
	assert.equal(defaults.getSlackToolStreaming(), "important", "Slack defaults to selected show:true tool labels");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: {
			default: true,
			slack: { default: "messages-only", C1234567890: true },
			email: { default: "messages-only", "email-alex_example_com": false },
			telegram: "messages-only",
		},
	}));

	const configured = new MomSettingsManager(workingDir);
	assert.equal(configured.getVerbose("C1234567890", "slack"), true, "Slack respects a configured channel override");
	assert.equal(configured.getVerbose("C9999999999", "slack"), "messages-only", "other Slack channels retain the configured default");
	assert.equal(configured.getVerbose("email-alex_example_com", "email"), false, "Email respects a configured channel override");
	assert.equal(configured.getVerbose("email-other_example_com", "email"), "messages-only", "other Email channels use the platform default");
	assert.equal(configured.getVerbose("8389147137", "telegram"), "messages-only", "platform-wide Telegram verbosity applies without a channel override");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({ verbose: { default: "messages-only", slack: true } }));
	const slackVerbose = new MomSettingsManager(workingDir);
	assert.equal(slackVerbose.getVerbose("C1234567890", "slack"), true, "platform-wide Slack verbosity overrides the global default");
	assert.equal(slackVerbose.getVerbose("email-alex_example_com", "email"), "messages-only", "Slack verbosity does not change Email");
	slackVerbose.setChannelVerbose("COVERRIDE", "slack", false);
	assert.equal(slackVerbose.getVerbose("COVERRIDE", "slack"), false, "channel override wins over the Slack platform default");
	assert.equal(slackVerbose.getVerbose("COTHER", "slack"), true, "adding a channel override preserves the Slack platform default");
	slackVerbose.setPlatformVerbose("slack", "messages-only");
	assert.equal(slackVerbose.getVerbose("COVERRIDE", "slack"), false, "changing the Slack platform default preserves channel overrides");
	assert.equal(slackVerbose.getVerbose("COTHER", "slack"), "messages-only", "changed Slack platform default applies to other channels");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({ verbose: { default: true } }));
	const globallyVerbose = new MomSettingsManager(workingDir);
	assert.equal(globallyVerbose.getVerbose("C1234567890", "slack"), true, "explicit verbose default overrides Slack messages-only");
	assert.equal(globallyVerbose.getVerbose("8389147137", "telegram"), true, "explicit verbose default overrides Telegram messages-only");
	globallyVerbose.setSlackToolStreaming("off");
	assert.equal(globallyVerbose.getSlackToolStreaming(), "off", "Slack tool-streaming mode can be turned off durably");

	assert.equal(isSendMessageOnlyPlatform("C1234567890"), true, "Slack channel ids retain the send_message-only default policy");
	assert.equal(isSendMessageOnlyPlatform("form-abc123"), false, "Form channels do not infer send_message-only policy");
	assert.equal(isSendMessageOnlyPlatform("web", "web"), false, "Web is not send_message-only");

	console.log("channel-delivery-policy ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
