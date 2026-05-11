# Phone Messaging Adapter (SMS/iMessage)

Date: 2026-05-11

The adapter is provider-neutral at the troublemaker boundary. Incoming webhooks must be normalized upstream to a canonical `PhoneInboundPayload`; troublemaker turns that into a `phone-...` channel and stores the channel registry in `phone-channels.json` under the agent data directory.

Provider drivers:
- `loop` sends iMessage/SMS/RCS/WhatsApp-style messages through LoopMessage.
- `twilio` sends SMS/MMS through Twilio.
- More iMessage bridges can be added by implementing the `PhoneMessagingProvider` interface.

Operational policy:
- This surface is for two-way conversational threads, not cold outbound broadcasts.
- Loop's warning is treated like the Twilio/telecom compliance boundary: the user or thread should initiate, or the business must have explicit consent.
- Group-thread support depends on provider payloads carrying a conversation/group id. Loop must be QA'd in sandbox for exact field names.

Channel behavior:
- Inbound events become DM-style `MomEvent`s with channel ids like `phone-<hash>`.
- `send_message_to_channel` can route to `phone-...` channels after the agent has seen an inbound message.
- Local file attachments are not supported yet; send public URLs until provider media upload is implemented.

QA required:
- Verify Loop sandbox inbound payloads for one-to-one iMessage, SMS fallback, and group chats.
- Verify Loop outbound group send payload shape and whether channel `imessage` automatically falls back or whether fallback requires selecting `sms`.
- Verify Twilio signature validation at the deployed Worker URL.
- Run one real inbound->agent->reply path before handing to Callie.
