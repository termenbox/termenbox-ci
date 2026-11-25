// Green for the cut (R138 2.9, finding F12): read the conclusion of the ci run, never a commit status. A status is posted
// by a step of a job where source code already ran, so it can be forged; the run conclusion of the ci repo cannot.
// Pinned: workflow ci.yaml, branch main, the push event, the newest run for the sha. A pull-request run of the same sha
// chooses its own scope with a source script and can finish green with every job skipped, so it never counts, and a push
// run whose jobs were all skipped does not count either.
export const WORKFLOW = "ci.yaml";
export const BRANCH = "main";
export const EVENT = "push";
const SHA = /^[0-9a-f]{40}$/;

// runs: workflow runs as the API returns them ({ id, head_sha, head_branch, event, path|name, conclusion, status, created_at }).
// jobs: the jobs of the chosen run ({ conclusion }). Returns { green, reason }.
export function readGreen({ sha, runs, jobs }) {
  if (!SHA.test(sha || "")) return { green: false, reason: "no release commit" };
  const mine = (runs || [])
    .filter((r) => r.head_sha === sha && r.head_branch === BRANCH && r.event === EVENT)
    .filter((r) => !r.path || r.path.split("@")[0].endsWith(`/${WORKFLOW}`))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const run = mine[0];
  if (!run) return { green: false, reason: "no ci run of main for this commit" };
  if (run.status !== "completed") return { green: false, reason: "the newest ci run is still going" };
  if (run.conclusion !== "success") return { green: false, reason: `the newest ci run concluded ${run.conclusion}` };
  const list = jobs || [];
  if (!list.some((j) => j.conclusion === "success")) return { green: false, reason: "the ci run ran no job" };
  return { green: true, reason: "", run: run.id };
}

// api: { runs(sha), jobs(runId) } over the GitHub API of the ci repo. Statuses are not read.
export async function isGreen(api, sha) {
  const runs = SHA.test(sha || "") ? await api.runs(sha) : [];
  const first = readGreen({ sha, runs, jobs: [{ conclusion: "success" }] });
  if (!first.run) return first;
  return readGreen({ sha, runs, jobs: await api.jobs(first.run) });
}
