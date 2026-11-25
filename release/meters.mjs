// Meter readers for the staged release flow. `--cadence` reads release-cadence (docs/meters/release-cadence.md).
// The reading is a pure function of two lists and a containment test, so tests need no network.
// A slot starts at the cut (owner, 2026-11-25): a slot is counted when develop moved since the previous cut, its change is
// the newest merge before the cut, and it passes when a stable release that CONTAINS that change is published within 8 hours.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const H = 3600e3;
const SLOT = 6 * H;
const PASS_WITHIN = 8 * H;

function p90(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

// merges: [{ t, sha }] develop moved (ms, merge commit); stables: [{ t, sha }] a stable release (ms, tag commit);
// contains(stableSha, mergeSha) is true when the stable's commit has the merge in its history (or is it).
export function cadence({ merges, stables, now, windowMs = 7 * 24 * H, contains }) {
  const from = now - windowMs;
  const firstSlot = Math.ceil(from / SLOT) * SLOT;
  const sorted = [...stables].sort((a, b) => a.t - b.t);
  const byTime = [...merges].sort((a, b) => a.t - b.t);
  let counted = 0;
  let passed = 0;
  for (let cut = firstSlot; cut + PASS_WITHIN <= now; cut += SLOT) {
    const change = [...byTime].reverse().find((m) => m.t < cut && m.t >= cut - SLOT);
    if (!change) continue; // develop did not move since the previous cut: no slot
    counted++;
    if (sorted.some((s) => s.t >= cut && s.t <= cut + PASS_WITHIN && contains(s.sha, change.sha))) passed++;
  }
  const leads = [];
  for (const m of byTime) {
    if (m.t < from || m.t > now) continue;
    const s = sorted.find((x) => x.t >= m.t && contains(x.sha, m.sha));
    if (s) leads.push(s.t - m.t);
  }
  const lead = p90(leads);
  let verdict = "UNKNOWN";
  if (counted >= 3) verdict = passed / counted >= 0.9 && lead !== null && lead <= 12 * H ? "PASS" : "FAIL";
  return { counted, passed, stableReleases: sorted.filter((s) => s.t >= from && s.t <= now).length, p90LeadHours: lead === null ? null : +(lead / H).toFixed(1), verdict };
}

export function format(r) {
  return `release-cadence counted=${r.counted} passed=${r.passed} stable=${r.stableReleases} p90_lead_h=${r.p90LeadHours ?? "none"} verdict=${r.verdict}`;
}

// "7d" or "12h" to milliseconds; anything else is an error, never a silent default.
export function parseWindow(text) {
  const m = /^(\d+)([hd])$/.exec(text || "");
  if (!m || Number(m[1]) < 1) throw new Error(`--window is not like 7d or 12h: ${text}`);
  return Number(m[1]) * (m[2] === "d" ? 24 * H : H);
}

export function parseNow(text) {
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--now is not a time: ${text}`);
  return t;
}

const MAX_PAGES = 10;

async function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
}

// Pages through a list newest first and stops at `stop(page)` or after MAX_PAGES.
async function pages(path, stop) {
  const out = [];
  for (let n = 1; n <= MAX_PAGES; n++) {
    const page = await gh(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${n}`]);
    out.push(...page);
    if (page.length < 100 || stop(page)) break;
  }
  return out;
}

async function fromGitHub(repo, sourceRepo, from) {
  const rels = await pages(`repos/${repo}/releases`, (p) => p.every((r) => Date.parse(r.published_at) < from));
  const tags = rels.filter((r) => !r.prerelease && !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name));
  const stables = [];
  for (const r of tags) stables.push({ t: Date.parse(r.published_at), sha: (await gh(["api", `repos/${sourceRepo}/commits/${r.tag_name}`])).sha });
  const prs = await pages(`repos/${sourceRepo}/pulls?state=closed&base=develop&sort=updated&direction=desc`, (p) => p.every((x) => Date.parse(x.updated_at) < from));
  const merges = prs.filter((p) => p.merged_at && p.merge_commit_sha).map((p) => ({ t: Date.parse(p.merged_at), sha: p.merge_commit_sha }));
  const cache = new Map();
  const contains = (stableSha, mergeSha) => {
    const k = `${stableSha}:${mergeSha}`;
    if (!cache.has(k)) {
      const status = stableSha === mergeSha ? "identical" : execCompare(sourceRepo, mergeSha, stableSha);
      cache.set(k, status === "ahead" || status === "identical");
    }
    return cache.get(k);
  };
  return { merges, stables, contains };
}

// compare base...head: status "ahead" means head has base in its history; a failed call reads as not contained.
function execCompare(repo, base, head) {
  try {
    return execFileSync("gh", ["api", `repos/${repo}/compare/${base}...${head}`, "--jq", ".status"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.includes("--cadence")) {
    console.error("usage: meters.mjs --cadence [--repo releases/repo] [--source-repo develop/repo] [--window 7d|12h] [--now ISO]");
    process.exit(2);
  }
  const val = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  try {
    const windowMs = parseWindow(val("--window", "7d"));
    const now = val("--now") ? parseNow(val("--now")) : Date.now();
    const { merges, stables, contains } = await fromGitHub(val("--repo", "termenbox/termenbox"), val("--source-repo", "termenbox/termenbox-source"), now - windowMs);
    console.log(format(cadence({ merges, stables, now, windowMs, contains })));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
