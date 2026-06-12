# Workspace Chat UI Reset

**Date:** 2026-06-12

## Why This Exists

The hosted workspace chat had drifted into a debug-console shape: always-visible
connection labels, token estimates, Realtime caps, timestamps, bright role
cards, and tool-color coding all competed with the actual conversation. Voice
made the problem obvious because the UI mixed text-model context, Realtime
voice handoff budget, and transport status into one strip without explaining
which mode the user was actually in.

The first reset is intentionally smaller than a full design-system rewrite. It
establishes product rules and removes the most confusing surface area.

## Product Rules

- The chat top bar should answer "who, where, and with what model" before it
  exposes transport internals.
- Context-window details are inspectable, not ambient. Token estimates belong
  behind a context-details control unless the user explicitly asks for them.
- Realtime voice's 32k-ish startup handoff budget must not masquerade as the
  whole text-chat model context window.
- Routine Realtime compaction is normal behavior. It should be part of the
  handoff contract, not a warning on every activation.
- Messages should read like a calm transcript. Borders, role colors, and tool
  state colors should be accents, not the dominant visual language.
- Tool calls remain expandable and auditable, but collapsed tool chrome should
  stay quiet enough that message text is still the primary artifact.

## First Slice Shipped

- Added `ChatTopBar` for agent/thread, text-vs-voice mode, model, thinking,
  settings, voice settings, and opt-in context details.
- Removed the legacy `StatusStrip` from the mounted workspace chat path.
- Changed context labels from debug strings like `ctx ~18k` and `rt ~18k/32k`
  to user-facing copy in the context inspector.
- Stopped surfacing normal compact Realtime handoffs as user-visible warnings.
- Flipped the voice-mode toggle icon so it represents the target mode.
- Flattened message and tool-call styling so the stream is closer to a
  transcript and less like stacked colored system cards.

## Follow-Ups

- Implement optional thread selection in the UI so Alex can keep the continuous
  rolling session while still having a normal thread affordance when wanted.
- Add a full model/context inspector that distinguishes text chat model,
  Realtime voice model, turn-based voice path, loaded transcript estimate, and
  persisted searchable context.
- Make the design tokens first-class instead of leaving them embedded in the
  monolithic CSS file.
- Finish turn-based voice reliability separately; its microphone/STT failure is
  a transport bug, not a reason to keep Realtime budget details in top chrome.
