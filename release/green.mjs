// Green for the cut (R138 2.9, finding F12): read the conclusion of the ci run, never a commit status. A status is posted
// by a step of a job where source code already ran, so it can be forged; the run conclusion of the ci repo cannot.
// The ci repo runs ci.yaml only on repository_dispatch (source-pushed) or workflow_dispatch, so a run's head_sha is the
// ci repo's own commit; the source commit and the kind of the run appear only in its display title:
//   "CI · <PR #n | tag | event | manual> · <source sha>"   (run-name of ci.yaml)
// A run counts only when it is a run of ci.yaml on the ci repo's main, its title ends with ` · <sha>`, it is not a pull
// request run (a PR run chooses its own scope with a source script), and its job `CI result` succeeded. Skipped jobs
// never count: `changes` and `ci` succeed even when the scoped-down run did nothing, only `CI result` is the verdict.
export const WORKFLOW = "ci.yaml";
export const BRANCH = "main";
export const EVENTS = ["repository_dispatch", "workflow_dispatch"];
export const RESULT_JOB = "CI result";
const SHA = /^[0-9a-f]{40}$/;
const PR_TITLE = /^CI · PR #\d+ · /;

// runs: ({ id, event, head_branch, path, display_title, conclusion, status, created_at }) as the API returns them.
// jobs: the jobs of the chosen run ({ name, conclusion }). Returns { green, reason, run? }.
export function chooseRun({ sha, runs }) {
  if (!SHA.test(sha || "")) return { reason: "no release commit" };
  const mine = (runs || [])
    .filter((r) => r.head_branch === BRANCH && EVENTS.includes(r.event))
    .filter((r) => typeof r.path === "string" && r.path.split("@")[0].endsWith(`/${WORKFLOW}`))
    .filter((r) => typeof r.display_title === "string" && r.display_title.endsWith(` · ${sha}`) && !PR_TITLE.test(r.display_title))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return mine[0] ? { run: mine[0] } : { reason: "no ci run of main for this commit" };
}

export function readGreen({ sha, runs, jobs }) {
  const { run, reason } = chooseRun({ sha, runs });
  if (!run) return { green: false, reason };
  if (run.status !== "completed") return { green: false, reason: "the newest ci run is still going" };
  if (run.conclusion !== "success") return { green: false, reason: `the newest ci run concluded ${run.conclusion}` };
  if (!(jobs || []).some((j) => j.name === RESULT_JOB && j.conclusion === "success")) return { green: false, reason: `the job ${RESULT_JOB} did not succeed` };
  return { green: true, reason: "", run: run.id };
}

// api: { runs(sha), jobs(runId) } over the GitHub API of the ci repo. Statuses are not read.
export async function isGreen(api, sha) {
  const runs = SHA.test(sha || "") ? await api.runs(sha) : [];
  const { run, reason } = chooseRun({ sha, runs });
  if (!run) return { green: false, reason };
  const jobs = run.status === "completed" && run.conclusion === "success" ? await api.jobs(run.id) : [];
  return readGreen({ sha, runs, jobs });
}
