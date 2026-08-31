import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fragment = readFileSync(
  new URL("../hostd/templates/relationship-operator-website-fragment.md", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../skills/frontend-design/SKILL.md", import.meta.url),
  "utf8",
);
const license = readFileSync(
  new URL("../skills/frontend-design/LICENSE.txt", import.meta.url),
  "utf8",
);

test("relationship website guidance centers understanding and reviewed previews", () => {
  assert.match(fragment, /Begin by understanding the person and the business/);
  assert.match(fragment, /clean `main` branch as the canonical accepted source/);
  assert.match(fragment, /Use a preview branch for a proposed change/);
  assert.match(fragment, /private sketch or first direction/);
  assert.match(fragment, /read and use the installed `frontend-design`\s+skill/);
  assert.doesNotMatch(fragment, /tinyfat-design-direction/);
  assert.doesNotMatch(fragment, /centered hero|pill-button|gradient wash/);
});

test("relationship replies are concise, adaptive, truthful, and durably stateful", () => {
  assert.match(fragment, /one to three\s+short sentences and no more than 320 characters/);
  assert.match(fragment, /Ask at most one\s+necessary question/);
  assert.match(fragment, /patterns the customer has actually shown/);
  assert.match(fragment, /Do not invent a persona, demographic, motive, mood, budget/);
  assert.match(fragment, /A short message is not evidence of impatience/);
  assert.match(fragment, /A \*\*capability\*\* is something a verified tool or\s+service can do/);
  assert.match(fragment, /\*\*Authorization\*\* is permission for this exact relationship/);
  assert.match(fragment, /An \*\*attempt\*\* means the action was actually invoked/);
  assert.match(fragment, /\*\*Completion\*\*\s+requires the authoritative provider or host receipt/);
  assert.match(fragment, /Payment comes only from payment-provider evidence/);
  assert.match(fragment, /domain is connected only after a host-operation receipt/);
  assert.match(fragment, /include `relationship_progress` in the same\s+`send_message` call/);
  assert.match(fragment, /`checkout_sent`\/`complete_checkout`/);
  assert.match(fragment, /`live_accepted`\/`none`/);
  assert.match(fragment, /keep them out of the customer-facing message/);
});

test("vendored frontend-design skill retains its declared Apache license", () => {
  assert.match(skill, /^---\nname: frontend-design\n/m);
  assert.match(skill, /license: Complete terms in LICENSE\.txt/);
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
});
