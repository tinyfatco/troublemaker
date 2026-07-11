# Active Model Identity In Prompt

**Date:** 2026-07-11  
**Commit:** `ea0b2d9`

Added the exact selected `provider/model` identity to the static system prompt
and instructed agents to report it rather than infer from memory. This fixes a
live Zip QA result where the runtime trace showed GPT-5.6 Sol but the agent
guessed an obsolete MiniMax identity in its email text.

Verification passed: typecheck/build, system prompt test, and VPS bootstrap
test. Production deployment and corrected self-report QA follow this commit.
