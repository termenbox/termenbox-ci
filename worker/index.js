// Receives the private repo's GitHub webhooks and starts the ci repo. Holds no source and spends no Actions minutes.
// Secrets (Worker secrets): WEBHOOK_SECRET (shared with the webhook), DISPATCH_TOKEN (contents write on the ci repo).
// Only the sha, the base sha, the pull request number, the event kind and (for a tag) the tag name leave this Worker:
// never a branch name, title, message or author.

const CI_REPO = "termenbox/termenbox-ci";
const SRC_REPO = "termenbox/termenbox";
const BRANCHES = ["master", "develop"];
const ZERO = /^0+$/;

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
  if (!p || !p.repository || p.repository.full_name !== SRC_REPO) return null;
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
    if (!pr.head.repo || pr.head.repo.full_name !== SRC_REPO) return null; // never a fork
    if (!BRANCHES.includes(pr.base.ref)) return null;
    return { event: "pull_request", sha: pr.head.sha, base: pr.base.sha, pr: String(pr.number) };
  }
  if (event === "issue_comment") {
    if (p.action !== "created" || !p.issue) return null;
    if (!String(p.comment && p.comment.body).startsWith("/")) return null;
    if (p.issue.pull_request) return { event: "comment", sha: "", base: "", pr: String(p.issue.number), comment_id: String(p.comment.id) };
    // A docs-media review issue: only its number and the comment id leave here; the workflow fetches the author and text itself.
    if (!(p.issue.labels || []).some((l) => l && l.name === "docs-media")) return null;
    return { event: "issue_comment", sha: "", base: "", pr: "", issue: String(p.issue.number), comment_id: String(p.comment.id) };
  }
  if (event === "issues") {
    // Ticking a line of a docs-media review issue edits its body; only the number and the editor's login leave here.
    if (p.action !== "edited" || !p.issue || p.issue.pull_request || !p.changes || !p.changes.body) return null;
    if (!(p.issue.labels || []).some((l) => l && l.name === "docs-media")) return null;
    return { event: "issue_edited", sha: "", base: "", pr: "", issue: String(p.issue.number), actor: String((p.sender && p.sender.login) || "") };
  }
  return null;
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
    const res = await fetch(`https://api.github.com/repos/${CI_REPO}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "termenbox-ci-hook",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event_type: "source-pushed", client_payload }),
    });
    return new Response(res.ok ? "dispatched" : `dispatch failed: ${res.status}`, { status: res.ok ? 202 : 502 });
  },
};
