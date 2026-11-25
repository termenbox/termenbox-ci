// The page and the pause of the staged release flow (R138 2.7).
// The owner is told through a labelled GitHub issue in the product repo: one issue per build and cause, naming the
// build, the ring and the reading, never the text of a finding. The pause is a repository variable that stops the cut
// and the promotion; a signed freeze is a separate thing and is neither read nor implied here.
export const PAUSE_VARIABLE = "RELEASE_PAUSED";
export const LABEL = "release-page";
export const CAUSES = ["gate-failure", "reviewer-finding", "ring-halt", "hold-missing-reading"];

const SAFE = /^[A-Za-z0-9._+-]{1,64}$/;

// True when the pause variable is set to a truthy value. `getVariable(name)` returns the value or null/undefined.
export async function isPaused(getVariable) {
  const v = await getVariable(PAUSE_VARIABLE);
  return typeof v === "string" && /^(1|true|yes|on|paused)$/i.test(v.trim());
}

// What a cut or a promotion calls first: returns { allowed, reason }.
export async function mayMove(getVariable) {
  return (await isPaused(getVariable)) ? { allowed: false, reason: "paused" } : { allowed: true, reason: "" };
}

export function marker(build, cause) {
  return `<!-- release-page build=${build} cause=${cause} -->`;
}

// The issue for a page. Only the build, the ring, the cause and the reading are used; a finding is a flag.
export function issueFor({ build, ring, cause, reading = "UNKNOWN", owner }) {
  if (!CAUSES.includes(cause)) throw new Error(`unknown cause ${cause}`);
  for (const [k, v] of [["build", build], ["ring", String(ring)], ["reading", reading]]) {
    if (!SAFE.test(v)) throw new Error(`${k} is not a plain token`);
  }
  const lines = [`Build ${build}, ring ${ring}: ${cause}.`, `Reading: ${reading}.`];
  if (cause === "reviewer-finding") lines.push("A finding exists. Read it in the review record, not here.");
  lines.push(marker(build, cause));
  return { title: `Release ${build}: ${cause} (ring ${ring})`, body: lines.join("\n"), labels: [LABEL], assignees: owner ? [owner] : [] };
}

// Opens the issue unless one for this build and cause exists (open or closed). `api` is { find(marker), create(issue) }.
export async function page(api, args) {
  const issue = issueFor(args);
  const existing = await api.find(marker(args.build, args.cause));
  if (existing) return { created: false, number: existing.number };
  const made = await api.create(issue);
  return { created: true, number: made.number };
}
