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

test("vendored frontend-design skill retains its declared Apache license", () => {
  assert.match(skill, /^---\nname: frontend-design\n/m);
  assert.match(skill, /license: Complete terms in LICENSE\.txt/);
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
});
