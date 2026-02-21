/**
 * Slash command handler for troublemaker.
 *
 * Intercepts /model (and future commands) at the handler level
 * before the message reaches the agent loop.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { PlatformAdapter } from "./adapters/types.js";
import { findModel, listModels, resolveModel } from "./model-config.js";
import * as log from "./log.js";

/**
 * Handle a slash command. Returns true if the command was handled.
 */
export async function handleSlashCommand(
	text: string,
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<boolean> {
	const parts = text.trim().split(/\s+/);
	const cmd = parts[0].toLowerCase();

	switch (cmd) {
		case "/model":
			await handleModelCommand(parts.slice(1), channelId, workingDir, platform);
			return true;
		default:
			return false;
	}
}

async function handleModelCommand(
	args: string[],
	channelId: string,
	workingDir: string,
	platform: PlatformAdapter,
): Promise<void> {
	// /model (no args) — show current model
	if (args.length === 0) {
		const model = resolveModel(workingDir);
		const models = listModels();

		// Group by provider
		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			const list = byProvider.get(m.provider) || [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		let response = `*Current model:* ${model.provider}/${model.id}\n\n`;
		response += `Use \`/model <name>\` to switch. Examples:\n`;
		response += `\`/model claude-sonnet-4-6\`\n`;
		response += `\`/model gpt-5.1\`\n`;
		response += `\`/model anthropic/claude-opus-4-6\`\n`;

		await platform.postMessage(channelId, response);
		return;
	}

	// /model list — show all available models
	if (args[0] === "list") {
		const models = listModels();
		const currentModel = resolveModel(workingDir);

		const byProvider = new Map<string, typeof models>();
		for (const m of models) {
			const list = byProvider.get(m.provider) || [];
			list.push(m);
			byProvider.set(m.provider, list);
		}

		let response = `*Available models:*\n`;
		for (const [provider, providerModels] of byProvider) {
			response += `\n*${provider}:*\n`;
			for (const m of providerModels.slice(0, 10)) {
				const current = m.provider === currentModel.provider && m.id === currentModel.id ? " ← current" : "";
				response += `  ${m.id}${current}\n`;
			}
			if (providerModels.length > 10) {
				response += `  _(${providerModels.length - 10} more)_\n`;
			}
		}

		await platform.postMessage(channelId, response);
		return;
	}

	// /model <query> — switch model
	const query = args.join(" ");
	const match = findModel(query);

	if (!match) {
		await platform.postMessage(
			channelId,
			`Model not found: "${query}"\n\nUse \`/model list\` to see available models.`,
		);
		return;
	}

	// Write to settings.json
	const settingsPath = join(workingDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			// Start fresh
		}
	}

	settings.defaultProvider = match.provider;
	settings.defaultModel = match.id;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

	log.logInfo(`Model switched to ${match.provider}/${match.id} via /model command`);
	await platform.postMessage(
		channelId,
		`Switched to *${match.provider}/${match.id}*\n_(takes effect on next message)_`,
	);
}
