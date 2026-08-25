#!/usr/bin/env node

import { fileURLToPath } from "url";
import { installTuiProfile, loadTuiProfiles, resolveInvokedAgent } from "./tui/config.js";
import { runTroublemakerTui } from "./tui/app.js";
import { viewTmuxToolProjection } from "./tui/tmux-tool-projection.js";

interface ParsedInstallArgs {
	command: string;
	name?: string;
	baseUrl: string;
	channelId?: string;
	binDir?: string;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const invokedAgent = resolveInvokedAgent(process.argv[1]);
	if (invokedAgent && args.length === 0) {
		await openAgent(invokedAgent);
		return;
	}
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
		printHelp();
		return;
	}

	const command = args.shift()!;
	if (command === "install") {
		const parsed = parseInstallArgs(args);
		const installed = installTuiProfile({
			command: parsed.command,
			name: parsed.name,
			baseUrl: parsed.baseUrl,
			channelId: parsed.channelId,
			binDir: parsed.binDir,
			executablePath: fileURLToPath(import.meta.url),
		});
		console.log(`Installed ${installed.profile.name}:`);
		console.log(`  command  ${installed.commandPath}`);
		console.log(`  config   ${installed.configPath}`);
		return;
	}
	if (command === "list") {
		const profiles = Object.values(loadTuiProfiles()).sort((a, b) => a.command.localeCompare(b.command));
		if (profiles.length === 0) {
			console.log("No agent commands installed.");
			return;
		}
		for (const profile of profiles) console.log(`${profile.command}\t${profile.name}\t${profile.baseUrl}`);
		return;
	}
	if (command === "tmux-view") {
		const selector = args.pop() || process.env.TROUBLEMAKER_TOOL_SELECTOR;
		const paneId = args.pop() || process.env.TROUBLEMAKER_TMUX_PANE || process.env.TMUX_PANE;
		if (!paneId || !selector || args.length > 0) throw new Error("Usage: troublemaker-tui tmux-view [pane-id] <tool-number>");
		viewTmuxToolProjection({ paneId, selector });
		return;
	}
	if (command === "open") {
		const agent = args.shift();
		if (!agent || args.length > 0) throw new Error("Usage: troublemaker-tui open <agent>");
		await openAgent(agent);
		return;
	}
	if (args.length > 0) throw new Error(`Unexpected arguments after agent name: ${args.join(" ")}`);
	await openAgent(command);
}

async function openAgent(command: string): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Troublemaker TUI requires an interactive terminal");
	}
	const profiles = loadTuiProfiles();
	const profile = profiles[command.toLowerCase()];
	if (!profile) {
		throw new Error(`No TUI profile is installed for "${command}". Run troublemaker-tui install ${command.toLowerCase()} --url <agent-url>`);
	}
	await runTroublemakerTui(profile);
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
	const command = args.shift();
	if (!command) throw new Error("Usage: troublemaker-tui install <command> --url <agent-url> [--name <display-name>] [--channel <channel-id>]");
	let name: string | undefined;
	let baseUrl: string | undefined;
	let channelId: string | undefined;
	let binDir: string | undefined;
	while (args.length > 0) {
		const flag = args.shift();
		const value = args.shift();
		if (!value) throw new Error(`Missing value for ${flag}`);
		if (flag === "--name") name = value;
		else if (flag === "--url") baseUrl = value;
		else if (flag === "--channel") channelId = value;
		else if (flag === "--bin-dir") binDir = value;
		else throw new Error(`Unknown install option: ${flag}`);
	}
	if (!baseUrl) throw new Error("Missing required option: --url");
	return { command, name, baseUrl, channelId, binDir };
}

function printHelp(): void {
	console.log(`Troublemaker terminal UI

Usage:
  troublemaker-tui install <command> --url <agent-url> [--name <name>] [--channel <id>]
  troublemaker-tui open <agent>
  troublemaker-tui list
  troublemaker-tui tmux-view [pane-id] <tool-number>
  <agent-command>

Installed agent commands open a Pi-styled terminal client against that agent's
canonical Troublemaker console session.`);
}

main().catch((error) => {
	console.error(`troublemaker-tui: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
