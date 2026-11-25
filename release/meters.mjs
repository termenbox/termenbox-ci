// Meter readers for the staged release flow. `--cadence` reads release-cadence (docs/meters/release-cadence.md).
// The reading is a pure function of two lists of times, so tests need no network.
const H = 3600e3;
const SLOT = 6 * H;
const PASS_WITHIN = 8 * H;

function p90(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

// merges: ms times develop moved; stables: ms times a stable release was published; now, windowMs: the window.
export function cadence({ merges, stables, now, windowMs = 7 * 24 * H }) {
  const from = now - windowMs;
  const firstSlot = Math.ceil(from / SLOT) * SLOT;
  const sorted = [...stables].sort((a, b) => a - b);
  let counted = 0;
  let passed = 0;
  for (let cut = firstSlot; cut + PASS_WITHIN <= now; cut += SLOT) {
    // a slot counts when develop moved since the previous cut
    if (!merges.some((m) => m >= cut - SLOT && m < cut)) continue;
    counted++;
    if (sorted.some((t) => t >= cut && t <= cut + PASS_WITHIN)) passed++;
  }
  const leads = [];
  for (const m of merges) {
    if (m < from || m > now) continue;
    const t = sorted.find((x) => x >= m);
    if (t !== undefined) leads.push(t - m);
  }
  const lead = p90(leads);
  let verdict = "UNKNOWN";
  if (counted >= 3) verdict = passed / counted >= 0.9 && lead !== null && lead <= 12 * H ? "PASS" : "FAIL";
  return { counted, passed, stableReleases: sorted.filter((t) => t >= from && t <= now).length, p90LeadHours: lead === null ? null : +(lead / H).toFixed(1), verdict };
}

export function format(r) {
  return `release-cadence counted=${r.counted} passed=${r.passed} stable=${r.stableReleases} p90_lead_h=${r.p90LeadHours ?? "none"} verdict=${r.verdict}`;
}

async function gh(args) {
  const { execFileSync } = await import("node:child_process");
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
}

async function fromGitHub(repo, sourceRepo) {
  const rels = await gh(["api", `repos/${repo}/releases?per_page=100`]);
  const stables = rels.filter((r) => !r.prerelease && !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name)).map((r) => Date.parse(r.published_at));
  const merged = (await gh(["api", "--paginate", "--slurp", `repos/${sourceRepo}/pulls?state=closed&base=develop&per_page=100&sort=updated&direction=desc`])).flat();
  const merges = merged.filter((p) => p.merged_at).map((p) => Date.parse(p.merged_at));
  return { merges, stables };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (!args.includes("--cadence")) {
    console.error("usage: meters.mjs --cadence [--repo releases/repo] [--source-repo develop/repo] [--window 7d] [--now ISO]");
    process.exit(2);
  }
  const val = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const days = parseInt(val("--window", "7d"), 10);
  const now = val("--now") ? Date.parse(val("--now")) : Date.now();
  const { merges, stables } = await fromGitHub(val("--repo", "termenbox/termenbox"), val("--source-repo", "termenbox/termenbox-source"));
  console.log(format(cadence({ merges, stables, now, windowMs: days * 24 * H })));
}
