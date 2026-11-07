// node worker/triggers.test.mjs : every event of the source repo starts exactly the workflows meant for it.
// The table is the contract: a source event goes through plan() and typesFor() to dispatch types, and a workflow listens to a
// type in `on.repository_dispatch.types`. Adding a trigger means changing the Worker, a workflow and this table together.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { plan, typesFor } from "./index.js";

const dir = new URL("../.github/workflows/", import.meta.url);
const listens = {};
const manual = {};
for (const f of readdirSync(dir)) {
  const text = readFileSync(new URL(f, dir), "utf8");
  const on = (/^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(text) || [])[1] || "";
  const m = /^  repository_dispatch:\n    types: \[([^\]]*)\]/m.exec(on);
  if (m) listens[f.replace(/\.ya?ml$/, "")] = m[1].split(",").map((s) => s.trim());
  manual[f.replace(/\.ya?ml$/, "")] = { dispatch: /^  workflow_dispatch:/m.test(on), sha: /^      sha:/m.test(on.split(/^  workflow_dispatch:/m)[1] || "") };
}

const repo = { full_name: "termenbox/termenbox-source" };
const A = "a".repeat(40), B = "b".repeat(40), Z = "0".repeat(40);
const prOn = (base) => ({ repository: repo, action: "synchronize", pull_request: { number: 7, head: { sha: A, repo }, base: { sha: B, ref: base } } });
const review = (label) => ({ number: 7, labels: [{ name: label }] });
const PUSHED = ["ci", "go-getter-checks", "ci-image", "docker-build"];

const rows = [
  ["push to develop", "push", { repository: repo, ref: "refs/heads/develop", after: A, before: B }, PUSHED],
  ["push to master", "push", { repository: repo, ref: "refs/heads/master", after: A, before: B }, [...PUSHED, "base-image", "deploy-site"]],
  ["pull request to develop", "pull_request", prOn("develop"), PUSHED],
  ["pull request to master", "pull_request", prOn("master"), PUSHED],
  ["tag v*", "push", { repository: repo, ref: "refs/tags/v1.2.3", after: A, before: Z }, ["release-stable", "release-beta", "docker-build"]],
  ["comment on a docs-media issue", "issue_comment", { repository: repo, action: "created", issue: review("docs-media"), comment: { id: 1, body: "/approve" } }, ["docs-media-review", "template-review"]],
  ["edit of a docs-media issue", "issues", { repository: repo, action: "edited", issue: review("docs-media"), changes: { body: { from: "x" } }, sender: { login: "o" } }, ["docs-media-review", "template-review"]],
  ["edit of a template-review issue", "issues", { repository: repo, action: "edited", issue: review("template-review"), changes: { body: { from: "x" } }, sender: { login: "o" } }, ["docs-media-review", "template-review"]],
];
const produced = new Set();
for (const [name, event, payload, want] of rows) {
  const cp = plan(event, payload);
  assert.ok(cp, `${name}: the Worker ignores it`);
  const types = typesFor(cp, payload);
  types.forEach((t) => produced.add(t));
  const got = Object.keys(listens).filter((w) => listens[w].some((t) => types.includes(t))).sort();
  assert.deepEqual(got, [...want].sort(), `${name} (${types.join("+")}) starts the wrong workflows`);
}
// events no workflow follows are not sent at all
assert.equal(plan("issue_comment", { repository: repo, action: "created", issue: { number: 3, pull_request: {} }, comment: { id: 2, body: "/regen" } }), null);
assert.equal(plan("push", { repository: repo, ref: "refs/heads/feature/x", after: A, before: B }), null);
assert.equal(plan("pull_request", prOn("feature/x")), null);
// a workflow that listens to a type nothing sends would never run
for (const [w, types] of Object.entries(listens)) for (const t of types) assert.ok(produced.has(t), `${w} listens to ${t}, which no row produces`);
// a workflow driven by a source push or pull request can be started by hand on a source commit, to test a change to the workflow itself
for (const w of PUSHED.concat(["base-image", "deploy-site"])) assert.ok(manual[w] && manual[w].dispatch && manual[w].sha, `${w} has no workflow_dispatch input sha`);
console.log("triggers: ok");
