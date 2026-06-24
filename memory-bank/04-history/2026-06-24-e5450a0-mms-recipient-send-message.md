# 2026-06-24 - MMS Recipient Send Message

Commits:
- `f050621` - Send Twilio phone replies to MMS groups
- `e5450a0` - Allow send_message to address MMS recipients

Summary:
- Added outbound MMS recipient persistence to phone channel records so Twilio replies can include the original sender plus additional group participants.
- Added explicit `recipients` support to `send_message` and the MCP-exposed send tool for phone targets.
- Added a group-aware phone adapter send path that promotes a phone channel to `mms`, persists `outboundRecipients`, and routes through the provider with the updated channel record.
- Covered the provider, phone adapter boundary, and `send_message` group-routing behavior with focused tests.

Verification:
- `npx tsx test/send-message.test.ts`
- `npx tsx test/phone-messages-only-boundary.test.ts`
- `npx tsx test/phone-messaging-twilio-provider.test.ts`
- `npm run typecheck`
- `npm run build`

Deploy status:
- Baked into `crawdad-cf` image version `371` via rollout commit `292b6ae`.
- Deployed from `tiny-bat` with `--containers-rollout=immediate`.
- Zip was restarted after deploy so the next interaction cold-starts on the new image.

Manual QA gaps:
- Twilio accepted a controlled `OtherRecipients0` send and returned a queued/sent SID, but the API response only echoed the primary `To` number.
- The live inbound MMS webhook did not include Austen in `OtherRecipients`, so true handset group delivery still needs confirmation from Alex/Austen.
- If `OtherRecipientsN` does not produce native group delivery for the current toll-free number, the likely next path is Twilio Conversations/projected-address group MMS rather than plain Programmable Messaging.
