# Small incremental input profile

Set `TROUBLEMAKER_INPUT_BUDGET=small` for an opt-in resident process using the OpenAI-compatible provider path. Restart only at an idle boundary with no pending input.

The provider projection admits at most 1,024 UTF-8 bytes of text per new user message or tool result, and 4,096 bytes across newly admitted messages in one request. These are byte limits, not approximate token counts. More than 16 new messages in one batch fails before inference, with an explicit error requesting a smaller batch. System instructions, tool schemas, harness checkpoint controls, assistant-generated history, and already admitted conversation history are outside this incremental text budget. Checkpoint controls remain intact because detail-reading tools are paused during handoff.

Oversized payloads have explicit truncation receipts. The `input_detail` tool reads bounded pages by byte offset or locates an exact query. Original canonical messages remain unchanged. The private `awareness/input-budget` directory retains text and exact provider projections across process restarts. Treat that directory as conversation data; do not publish it. Deleting it can invalidate cache reuse and loses detail references.

On first enablement, messages older than the profile's durable epoch retain their original provider content. This deliberately avoids reprocessing the existing conversation at deployment. Newly admitted projections are immutable even when later messages arrive, so batch budgeting cannot reshape the cached prefix. The profile does not shrink previously admitted oversized history.

New user turns also carry concise answer-before-memory guidance. This preserves diligent memory saving while asking for useful conversational text before optional housekeeping. This ordering is model guidance, not a tool-execution prohibition or an assurance that the model will always comply. The existing streamed assistant-text path can deliver text while tool work continues.

Non-text attachments are represented by an explicit omission notice in this text profile; request targeted text observations instead. Original attachments remain in canonical history. This profile is intended for text agents, not vision workloads.

Verification: `pnpm exec tsx test/input-budget.test.ts`. Coverage includes exact byte limits, lossless Unicode pagination, query lookup, tool-result identity, aggregate admission limits, original-history preservation, restart stability, and append-only cache projections.
