import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSendMessageOnlyPlatform, MomSettingsManager } from "../src/context.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-channel-policy-"));

try {
	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: {
			default: true,
			slack: { C1234567890: true },
			email: { "email-alex_example_com": true },
		},
	}));

	const mgr = new MomSettingsManager(workingDir);

	assert.equal(mgr.getVerbose("C1234567890", "slack"), "messages-only", "Slack ignores verbose overrides");
	assert.equal(mgr.getVerbose("8389147137", "telegram"), "messages-only", "Telegram is send_message-only");
	assert.equal(mgr.getVerbose("1443881334165733493", "discord"), "messages-only", "Discord is send_message-only");
	assert.equal(mgr.getVerbose("email-alex_example_com", "email"), "messages-only", "Email is send_message-only");
	assert.equal(mgr.getVerbose("phone-abc123", "phone"), "messages-only", "Phone messaging is send_message-only");
	assert.equal(mgr.getVerbose("form-abc123", "form"), true, "Form ingress does not force the generic send_message-only prompt");
	assert.equal(mgr.getVerbose("web", "web"), true, "Web chat keeps direct harness streaming");
	assert.equal(isSendMessageOnlyPlatform("C1234567890"), true, "Slack channel ids infer send_message-only policy");
	assert.equal(isSendMessageOnlyPlatform("form-abc123"), false, "Form channels do not infer send_message-only policy");
	assert.equal(isSendMessageOnlyPlatform("web", "web"), false, "Web is not send_message-only");

	console.log("channel-delivery-policy ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
