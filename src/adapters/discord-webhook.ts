import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import { stripDiscordMentions } from "./discord-format.js";
import { DiscordBase, type DiscordBaseConfig } from "./discord-base.js";
import type { MomEvent } from "./types.js";

const MAXIMUM_WEBHOOK_BYTES = 1024 * 1024;

// ============================================================================
// DiscordWebhookAdapter — HTTP Interactions endpoint
//
// Receives Discord Interaction payloads (slash commands) via HTTP POST.
// Responds with type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) immediately,
// then the agent processes and responds via follow-up REST calls.
// ============================================================================

export interface DiscordWebhookAdapterConfig extends DiscordBaseConfig {
	/** Ed25519 public key for verifying interaction signatures */
	publicKey: string;
	/** Scoped capability for trusted Gateway MESSAGE_CREATE relay traffic. */
	upstreamToken?: string;
}

export class DiscordWebhookAdapter extends DiscordBase {
	private publicKey: string;
	private upstreamToken?: string;
	private cryptoKey: Awaited<ReturnType<typeof crypto.subtle.importKey>> | null = null;

	constructor(config: DiscordWebhookAdapterConfig) {
		super(config);
		this.publicKey = config.publicKey;
		this.upstreamToken = config.upstreamToken;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("DiscordWebhookAdapter: handler not set. Call setHandler() before start().");

		// Import the Ed25519 public key for signature verification
		this.cryptoKey = await crypto.subtle.importKey(
			"raw",
			hexToUint8Array(this.publicKey),
			{ name: "Ed25519" },
			false,
			["verify"],
		);

		log.logInfo(`Discord bot (webhook): app=${this.applicationId}`);
		log.logConnected();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const url = req.url || "";
		let pathname = "";
		try {
			pathname = new URL(url, "http://localhost").pathname;
		} catch {
			res.writeHead(400);
			res.end("Invalid request URL");
			return;
		}
		const gatewayRelay = pathname === "/discord/messages";
		if (gatewayRelay && (!this.upstreamToken || !bearerMatches(req.headers.authorization, this.upstreamToken))) {
			res.writeHead(401);
			res.end("Unauthorized");
			return;
		}
		const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
		if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
			res.writeHead(415);
			res.end("JSON required");
			return;
		}
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			totalBytes += chunk.byteLength;
			if (totalBytes > MAXIMUM_WEBHOOK_BYTES) {
				rejected = true;
				res.writeHead(413);
				res.end("Request too large");
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", async () => {
			if (rejected) return;
			const rawBody = Buffer.concat(chunks).toString("utf-8");

			// Route: /discord/messages — scoped Gateway relay MESSAGE_CREATE.
			if (gatewayRelay) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));

				try {
					const payload = JSON.parse(rawBody);
					await this.handleGatewayMessage(payload);
				} catch (err) {
					log.logWarning("[discord] handleGatewayMessage error", err instanceof Error ? err.message : String(err));
				}
				return;
			}

			// Route: /discord/interactions — standard Interactions webhook
			const signature = req.headers["x-signature-ed25519"] as string | undefined;
			const timestamp = req.headers["x-signature-timestamp"] as string | undefined;

			if (!signature || !timestamp) {
				res.writeHead(401);
				res.end("Missing signature headers");
				return;
			}

			const isValid = await this.verifySignature(timestamp, rawBody, signature);
			if (!isValid) {
				log.logWarning("Discord interaction signature verification failed");
				res.writeHead(401);
				res.end("Invalid signature");
				return;
			}

			let interaction: DiscordInteraction;
			try {
				interaction = JSON.parse(rawBody);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			// Handle PING (type 1) — Discord verification handshake
			if (interaction.type === 1) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ type: 1 }));
				log.logInfo("Discord PING verification passed");
				return;
			}

			// Handle APPLICATION_COMMAND (type 2) — slash commands
			if (interaction.type === 2) {
				// Respond immediately with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5)
				// Discord shows "Bot is thinking..." in the channel
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ type: 5 }));

				// Process the interaction asynchronously
				this.handleApplicationCommand(interaction).catch((err) => {
					log.logWarning("[discord] handleApplicationCommand error", err instanceof Error ? err.message : String(err));
				});
				return;
			}

			// Unknown interaction type — ack and ignore
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ type: 1 }));
		});
	}

	// ==========================================================================
	// Signature verification (Ed25519)
	// ==========================================================================

	private async verifySignature(timestamp: string, body: string, signature: string): Promise<boolean> {
		if (!this.cryptoKey) return false;

		try {
			const message = new TextEncoder().encode(timestamp + body);
			const sig = hexToUint8Array(signature);

			return await crypto.subtle.verify(
				"Ed25519",
				this.cryptoKey,
				sig,
				message,
			);
		} catch (err) {
			log.logWarning("[discord] Signature verification error", err instanceof Error ? err.message : String(err));
			return false;
		}
	}

	// ==========================================================================
	// Application command handler
	// ==========================================================================

	private async handleApplicationCommand(interaction: DiscordInteraction): Promise<void> {
		const channelId = interaction.channel_id;
		if (!channelId) {
			log.logWarning("[discord] No channel_id in interaction");
			return;
		}

		// Extract user info
		const discordUser = interaction.member?.user || interaction.user;
		if (!discordUser) {
			log.logWarning("[discord] No user in interaction");
			return;
		}

		const userId = discordUser.id;
		const userName = discordUser.username;
		const displayName = discordUser.global_name || discordUser.username;
		if (!this.acceptsIncomingDiscordMessage({
			guildId: interaction.guild_id ?? null,
			channelId,
			userId,
			isDM: !interaction.guild_id,
		})) {
			log.logInfo("[discord] Ignoring interaction outside configured inbound boundaries");
			return;
		}

		// Track user
		this.users.set(userId, { id: userId, userName, displayName });

		// Track channel
		const channelName = interaction.channel?.name || channelId;
		this.channels.set(channelId, { id: channelId, name: channelName });

		// Extract message text from command options
		// The slash command has a single "message" option with the freeform text
		let text = "";
		const options = interaction.data?.options;
		if (options) {
			for (const opt of options) {
				if (opt.name === "message" && typeof opt.value === "string") {
					text = opt.value;
				}
			}
		}

		if (!text.trim()) {
			// No message — edit the deferred response to say so
			await this.editInteractionResponse(interaction.token, "_No message provided_");
			return;
		}

		const momEvent: MomEvent = {
			type: interaction.guild_id ? "mention" : "dm",
			channel: channelId,
			ts: interaction.id,
			user: userId,
			text: stripDiscordMentions(text),
			rawText: text,
			sourceEventType: "discord_slash_command",
			directlyAddressed: true,
			replyTarget: `discord:${channelId}`,
			replyTargetDescription: interaction.guild_id ? "Discord channel where this slash command arrived" : "Discord DM",
		};

		// Attach interaction token to event for context creation
		(momEvent as any)._interactionToken = interaction.token;

		// Log user message
		this.logToFile({
			date: new Date().toISOString(),
			ts: interaction.id,
			channel: `discord:#${channelName}`,
			channelId,
			user: userId,
			userName,
			displayName,
			text,
			attachments: [],
			isBot: false,
		});

		if (this.handler.resolvePendingInput(channelId, text)) {
			return;
		}

		if (await this.handler.handleSlashCommand(momEvent, this)) {
			return;
		}

		// Check for stop
		if (text.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(channelId)) {
				this.handler.handleStop(channelId, this);
			} else {
				await this.editInteractionResponse(interaction.token, "_Nothing running_");
			}
			return;
		}

		// Steer into active run or start new one
		if (this.handler.isRunning(channelId)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.enqueueWork(channelId, async () => { await this.handler.handleEvent(momEvent, this); });
		}
	}
}

function bearerMatches(header: string | undefined, expected: string): boolean {
	const actual = new TextEncoder().encode(/^Bearer ([^\s]+)$/i.exec(header || "")?.[1] || "");
	const wanted = new TextEncoder().encode(expected);
	if (actual.byteLength !== wanted.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < actual.byteLength; index++) difference |= actual[index]! ^ wanted[index]!;
	return difference === 0;
}

// ============================================================================
// Helpers
// ============================================================================

function hexToUint8Array(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

// ============================================================================
// Discord Interaction types (minimal, just what we need)
// ============================================================================

interface DiscordInteraction {
	id: string;
	type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
	token: string;
	application_id: string;
	guild_id?: string;
	channel_id?: string;
	channel?: { id: string; name?: string };
	member?: {
		user: DiscordUser;
	};
	user?: DiscordUser; // Present in DMs (no guild)
	data?: {
		id: string;
		name: string;
		options?: Array<{
			name: string;
			type: number;
			value: string | number | boolean;
		}>;
	};
}

interface DiscordUser {
	id: string;
	username: string;
	global_name?: string;
	discriminator?: string;
}
