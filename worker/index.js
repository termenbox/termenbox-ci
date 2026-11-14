// Receives the private repo's GitHub webhooks and starts the ci repo. Holds no source and spends no Actions minutes.
// Secrets (Worker secrets): WEBHOOK_SECRET (shared with the webhook), DISPATCHER_APP_ID and DISPATCHER_APP_KEY (the PKCS#8 key of
// the dispatcher app, contents write on the ci repo only; a token of one hour is minted from them). DISPATCH_TOKEN (a personal
// token) is used only while the app's secrets are not set, and goes with the cutover.
// Only the sha, the base sha, the pull request number, the event kind and (for a tag) the tag name leave this Worker:
// never a branch name, title, message or author.

import { installationToken } from "./app-token.js";

const CI_REPO = "termenbox/termenbox-ci";
// The source is renamed in two steps; both names are accepted until every reference follows the new one.
const SRC_REPOS = ["termenbox/termenbox-source"];
const isSource = (r) => !!r && SRC_REPOS.includes(r.full_name);
const BRANCHES = ["master", "develop"];
const ZERO = /^0+$/;
// Review issues the workflows follow: a docs-media video review and a template-review probe-page acceptance.
const REVIEW_LABELS = ["docs-media", "template-review"];
const isReview = (issue) => (issue.labels || []).some((l) => l && REVIEW_LABELS.includes(l.name));

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function validSignature(secret, body, header) {
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, body));
  const got = header.slice(7);
  if (want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Maps a webhook to the dispatch payload, or null when the event is not one we run.
export function plan(event, p) {
  if (!p || !isSource(p.repository)) return null;
  if (event === "push") {
    if (!p.after || ZERO.test(p.after)) return null;
    const m = /^refs\/heads\/(.+)$/.exec(p.ref || "");
    if (m && BRANCHES.includes(m[1])) return { event: "push", sha: p.after, base: p.before && !ZERO.test(p.before) ? p.before : "", pr: "" };
    const t = /^refs\/tags\/(v.+)$/.exec(p.ref || "");
    if (t) return { event: "tag", sha: p.after, base: "", pr: "", tag: t[1] };
    return null;
  }
  if (event === "pull_request") {
    const pr = p.pull_request;
    if (!pr || !["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) return null;
    if (!isSource(pr.head.repo)) return null; // never a fork
    if (!BRANCHES.includes(pr.base.ref)) return null;
    return { event: "pull_request", sha: pr.head.sha, base: pr.base.sha, pr: String(pr.number) };
  }
  if (event === "issue_comment") {
    if (p.action !== "created" || !p.issue) return null;
    if (!String(p.comment && p.comment.body).startsWith("/")) return null;
    // No workflow follows a comment on a pull request, so none is sent (it would only start runs that skip).
    if (p.issue.pull_request) return null;
    // A docs-media review issue: only its number and the comment id leave here; the workflow fetches the author and text itself.
    if (!(p.issue.labels || []).some((l) => l && l.name === "docs-media")) return null;
    return { event: "issue_comment", sha: "", base: "", pr: "", issue: String(p.issue.number), comment_id: String(p.comment.id) };
  }
  if (event === "issues") {
    // Ticking a line of a review issue edits its body; only the number and the editor's login leave here (never the old or new body:
    // template-review rebuilds the previous state from its own acceptance comments).
    if (p.action !== "edited" || !p.issue || p.issue.pull_request || !p.changes || !p.changes.body) return null;
    if (!isReview(p.issue)) return null;
    return { event: "issue_edited", sha: "", base: "", pr: "", issue: String(p.issue.number), actor: String((p.sender && p.sender.login) || "") };
  }
  return null;
}

// The dispatch types to send for a planned event: a workflow listens only to the types it needs (its `on.repository_dispatch.types`),
// so a tag-only or master-only workflow gets no run, and holds no runner, for a push it would skip. worker/triggers.test.mjs
// pins which workflows listen to which type: change a type and a workflow together.
// The CI image is rebuilt only for a push that changes its Dockerfile (its own gate decides again), so the other pushes, a pull
// request and a comment send it nothing and it holds no runner. A push event lists the files of at most 20 commits; a list that is
// missing, at its limit, or empty for a commit (a merge commit lists none) may hide the file, so it counts as a change.
const IMAGE_FILES = new Set(["docker/Dockerfile.ci"]);
export function mayChangeImage(p) {
  const commits = Array.isArray(p.commits) ? p.commits : [];
  if (commits.length === 0 || commits.length >= 20) return true;
  return commits.some((c) => {
    const lists = c ? [c.added, c.modified, c.removed] : [];
    if (lists.length !== 3 || !lists.every(Array.isArray)) return true;
    const files = lists.flat();
    return files.length === 0 || files.some((f) => IMAGE_FILES.has(f));
  });
}

export function typesFor(cp, p) {
  if (cp.event === "tag") return ["source-tag"];
  if (cp.event === "push") {
    const types = p.ref === "refs/heads/master" ? ["source-pushed", "source-master"] : ["source-pushed"];
    return mayChangeImage(p) ? [...types, "source-image"] : types;
  }
  if (cp.event === "pull_request") return ["source-pushed"];
  return ["source-comment"];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await request.arrayBuffer();
    if (!(await validSignature(env.WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256")))) {
      return new Response("bad signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event");
    if (event === "ping") return new Response("pong");
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response("bad json", { status: 400 }); }
    const client_payload = plan(event, payload);
    if (!client_payload) return new Response("ignored", { status: 202 });
    let failed = 0;
    let token = env.DISPATCH_TOKEN;
    let how = "";
    if (env.DISPATCHER_APP_ID && env.DISPATCHER_APP_KEY) {
      try {
        token = await installationToken({ appId: env.DISPATCHER_APP_ID, pem: env.DISPATCHER_APP_KEY, repo: CI_REPO, permissions: { contents: "write" } });
      } catch {
        // While the personal token is still set a failed mint falls back to it, so a bad rollout does not stop every run.
        if (!env.DISPATCH_TOKEN) return new Response("no dispatch token", { status: 502 });
        how = " (personal token: the app token failed)";
      }
    }
    for (const event_type of typesFor(client_payload, payload)) {
      const res = await fetch(`https://api.github.com/repos/${CI_REPO}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "termenbox-ci-hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_type, client_payload }),
      });
      if (!res.ok) failed = res.status;
    }
    return new Response(failed ? `dispatch failed: ${failed}` : `dispatched${how}`, { status: failed ? 502 : 202 });
  },
};
