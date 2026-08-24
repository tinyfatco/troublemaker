---
name: tinyfat-design-direction
description: Select, build, and independently gate a tailored TinyFat website direction from source-backed business and interview evidence. Use for every new site, redesign, private preview, or substantial visual iteration before coding or deploying.
---

# TinyFat Design Direction

Use this skill before building or materially redesigning a TinyFat website. It
prevents unrelated sites from collapsing into the same generic centered hero,
rounded card grid, gradient, and pill-button pattern.

The customer should experience a warm conversation and a useful preview—not an
internal design process. Never mention this skill, contracts, grammar IDs,
checks, agent roles, routing, or deployment mechanics to the customer.

## Interview boundary

- Acknowledge the person's request warmly before asking anything.
- Read the current relationship, public business evidence, prior project files,
  and any existing site before asking the person to repeat facts.
- Ask at most one focused question at a time, and only when its answer changes a
  consequential decision that cannot be made safely from evidence.
- Practice name, exact location, final phone, final photos, booking URLs, and
  similar details are often optional for a first private preview. Record them as
  open questions and proceed with clearly bounded assumptions when safe.
- State uncertainty plainly in the conversation. Never invent a fact, claim,
  price, testimonial, credential, location, form route, booking link, or image.
- If the evidence already supports one safe direction, explain the assumption
  naturally and make progress. Do not turn intake into a questionnaire.
- A person may redirect the visual direction naturally after seeing a preview.
  Record that feedback as a new evidence-backed iteration; do not discard the
  prior rationale or silently fall back to the default layout.

The CLI's interview plan is internal guidance, not customer copy. The agent
must author every visible message naturally.

## Durable project files

Keep these files at the project root and commit them with the source:

- `design-brief.json` — source-backed business, audience, desired/avoided
  qualities, references, existing-site state, assumptions, optional open
  questions, and provenance.
- `design-direction.json` — selected executable grammar, rationale, all design
  axes, hard prohibited defaults, evidence references, and append-only
  iteration history.
- `design-review.json` — independent release review with exact screenshots,
  functional checks, recent-output fingerprints, and existing-site comparison.

Do not store phone numbers, customer email addresses, relationship/channel IDs,
provider payloads, credentials, or unrelated relationship facts in these files.
Use local evidence labels that point to the current relationship's private
source notes.

The brief and direction schemas are enforced by `lib/design-direction.mjs`.
Start from `examples/design-brief.json` and
`examples/design-review.template.json`; do not guess omitted fields. The
executable grammar library is `grammars/v1.json`.

## Workflow

Resolve this skill directory from the `<location>` shown in the session preamble,
then use its absolute path as `$DESIGN_SKILL` below.

1. Gather only source-backed evidence. Inspect an existing public site when one
   exists. Keep factual source notes private.
2. Create `design-brief.json` with schema `tinyfat.design-brief/v1`.
3. Validate and plan the interview:

   ```bash
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" validate-brief --brief design-brief.json
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" plan-interview --brief design-brief.json
   ```

4. Select one deliberate direction before coding. Automatic selection uses
   business shape plus desired/avoided qualities; use `--grammar` only after an
   explicit evidence review:

   ```bash
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" select \
     --brief design-brief.json --out design-direction.json
   ```

5. Scaffold the selected executable grammar, then replace and refine the
   source-backed content without removing its structural/provenance markers:

   ```bash
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" scaffold \
     --brief design-brief.json --direction design-direction.json --out site
   ```

   The scaffold is a structural starting point, not finished customer copy.
   Preserve the selected information architecture, topology, type posture,
   density, geometry, imagery role, navigation, interaction posture, required
   sections, and prohibited defaults. Cosmetic theme changes are not a new
   direction.

6. Before any deployment, run the candidate gate:

   ```bash
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" check \
     --project . --stage candidate
   ```

7. If Hostd supplies `site_create` / `site_deploy`, those relationship-scoped
   tools are the only deployment authority. Never use a broad platform token or
   `yeet` as a fallback. Commit a clean branch and deploy a non-main candidate
   branch for internal review only. Do not give that URL to the customer yet.
8. A different reviewer must inspect fresh desktop, common-phone, and exact
   320px screenshots; accessibility, content truth, privacy, forms, assets,
   overflow, browser errors, external requests; and structural comparison
   against at least two recent outputs. The builder cannot approve its own work.
   Do not force novelty for its own sake or ban split openings: if a similar
   structure genuinely fits the business, the independent receipt must approve
   it with a specific rationale tied to evidence. Unjustified repetition fails.
9. If a public existing site is live, the independent review must compare it to
   the candidate. If the candidate is not a credible improvement, stop. Do not
   replace, deliver, or rationalize an inferior preview.
10. Save the independent receipt as `design-review.json`, then run:

   ```bash
   node "$DESIGN_SKILL/bin/tinyfat-design.mjs" check \
     --project . --stage release
   ```

11. Only after that release gate passes may the exact reviewed commit be
    deployed to the canonical private review branch and verified. Production,
    custom-domain, DNS, billing, and customer-account changes remain separate
    owner/customer decisions.

## Iteration

When feedback changes one aspect, append it before editing:

```bash
node "$DESIGN_SKILL/bin/tinyfat-design.mjs" iterate \
  --brief design-brief.json --direction design-direction.json \
  --kind customer-feedback \
  --summary 'Requested a quieter image treatment while keeping the guided path.' \
  --evidence interview-4
```

Change the requested aspect while retaining the direction's other constraints.
If the feedback requires a different grammar, select it deliberately from the
new evidence and preserve the previous direction in Git history and the review
receipt.

## Hard stops

- Do not build from a vague request when there is no safe business purpose to
  preserve; ask one natural purpose question.
- Do not hold a safe first preview hostage to optional unanswered details.
- Do not deploy a generic default that violates the selected grammar.
- Do not send an unreviewed candidate URL to the customer.
- Do not claim working forms, calendars, checkout, integrations, or production
  behavior that was not verified.
- Do not replace a stronger existing site with an inferior candidate.
- Do not bypass WFP custody, clean-Git provenance, branch isolation, immutable
  receipts, or rollback.
