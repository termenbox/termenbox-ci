// The page and the pause of the staged release flow (R138 2.7).
// The owner is told through a labelled GitHub issue in the product repo: one issue per build and cause, naming the
// build, the ring and the reading, never the text of a finding. The pause is a repository variable that stops the cut
// and the promotion; a signed freeze is a separate thing and is neither read nor implied here.
export const PAUSE_VARIABLE = "RELEASE_PAUSED";
export const LABEL = "release-page";
export const CAUSES = ["gate-failure", "reviewer-finding", "ring-halt", "hold-missing-reading"];

const SAFE = /^[A-Za-z0-9._+-]{1,64}$/;

// The pause fails closed: an unset variable (null/undefined, the API's 404) does not pause; any other non-empty value
// pauses unless it is an explicit "off" (0, false, no, off). So `pause`, `stop` or `y` pause, a typo never lifts it.
export async function isPaused(getVariable) {
  const v = await getVariable(PAUSE_VARIABLE);
  if (v === null || v === undefined) return false;
  const t = String(v).trim();
  return t !== "" && !/^(0|false|no|off)$/i.test(t);
}

// A reader over the API: `request(name)` returns { status, value }. Only a 404 means unset; any other failure throws,
// and mayMove then refuses the move (a 403, a 500 or a network error must never read as "not paused").
export function variableReader(request) {
  return async (name) => {
    const r = await request(name);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`variable ${name} unreadable (${r.status})`);
    return r.value;
  };
}

// What a cut or a promotion calls first: returns { allowed, reason }.
export async function mayMove(getVariable) {
  try {
    return (await isPaused(getVariable)) ? { allowed: false, reason: "paused" } : { allowed: true, reason: "" };
  } catch {
    return { allowed: false, reason: "pause unreadable" };
  }
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

// Opens the issue unless one for this build and cause exists (open or closed). `api` is { search(marker), create(issue) };
// search returns candidate issues ({ number, body, labels: [name], author }). Only an issue that carries the `release-page`
// label (outsiders cannot set labels) and was written by `appLogin` counts, so a stranger who pre-creates an issue with the
// predictable marker cannot suppress a page. Known race: two runs that search at the same moment can both create; the
// callers (the cut and the controller) run one at a time per build, and a duplicate page is the safe failure.
export async function page(api, args, appLogin) {
  if (!appLogin) throw new Error("page needs the login of the app that writes pages");
  const issue = issueFor(args);
  const m = marker(args.build, args.cause);
  const found = (await api.search(m)) || [];
  const existing = found.find((i) => i.author === appLogin && (i.labels || []).includes(LABEL) && String(i.body).includes(m));
  if (existing) return { created: false, number: existing.number };
  const made = await api.create(issue);
  return { created: true, number: made.number };
}
