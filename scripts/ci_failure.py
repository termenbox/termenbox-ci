#!/usr/bin/env python3
"""Make a failed job of this repo readable from the source repo, without leaking.

Used by .github/actions/finish on a failure only. Subcommands:

  summary --job J --log FILE          one line (<= 100 chars) naming the job, its failing step id and the first failing test names
  describe-needs  (NEEDS json on stdin)  the commit-status description (<= 140 chars) of the `ci` job
  comment --sha S --job J --run-url U --log FILE --out FILE   the issue comment: header, failing test names, last 150 log lines, scrubbed

The log is the job's quiet log (scripts/quiet.sh). Everything that leaves this process goes through scrub(): the value of
every environment variable (and every value inside a JSON object held in one, which is how `toJSON(secrets)` arrives),
their URL-encoded and base64 forms, and secret-shaped patterns. Any error exits non-zero and writes nothing.
"""
import argparse
import base64
import json
import os
import re
import sys
from urllib.parse import quote

REDACTED = "[redacted]"
COMMENT_LIMIT = 65536  # GitHub's limit on an issue comment
BODY_BUDGET = 60000  # what the comment may use, so the header and fence always fit
TAIL_LINES = 150
MIN_SECRET = 8  # a shorter env value (`true`, `1`, `C.UTF-8`) is not a secret and would shred the log
MAX_NAMES = 20

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
STEP_MARK = re.compile(r"^::termenbox-step-failed:: id=(\S*) exit=(\d+) cmd=(.*)$", re.M)

# Failing test names. cargo: `test a::b ... FAILED`; node:test TAP: `not ok 3 - name`; pnpm/vitest: `FAIL  path > name`.
CARGO = re.compile(r"^\s*test (\S.*?) \.\.\. FAILED\s*$", re.M)
NODE = re.compile(r"^\s*not ok \d+ - (.+?)(?:\s+#.*)?\s*$", re.M)
VITEST = re.compile(r"^(?:\S+ \S+: )?\s*FAIL\s+(\S.*?)\s*$", re.M)


def parse_test_names(text):
    """Failing test names in order of appearance, without duplicates."""
    found = []
    for m in re.finditer("|".join(f"(?:{r.pattern})" for r in (CARGO, NODE, VITEST)), text, flags=re.M):
        name = next(g for g in m.groups() if g)
        if name not in found:
            found.append(name)
    return found


def short_name(name, width=60):
    """A name as it may appear in a status: a restricted alphabet, one line, bounded."""
    name = re.sub(r"[^A-Za-z0-9_:./\[\]<>(),= -]", "?", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name if len(name) <= width else name[: width - 3] + "..."


def secret_values(environ):
    """Every value the scrubber must remove: env values, lines of multi-line ones, leaves of JSON objects, encoded forms."""
    out = set()

    def add(v):
        if isinstance(v, str) and len(v) >= MIN_SECRET:
            out.add(v)
            out.add(quote(v, safe=""))
            out.add(base64.b64encode(v.encode()).decode())
            out.add(base64.b64encode(v.encode()).decode().rstrip("="))

    def leaves(x):
        if isinstance(x, dict):
            for v in x.values():
                leaves(v)
        elif isinstance(x, list):
            for v in x:
                leaves(v)
        else:
            add(x)

    for value in environ.values():
        add(value)
        for line in value.splitlines():
            add(line.strip())
        if value.lstrip().startswith(("{", "[")):
            try:
                leaves(json.loads(value))
            except ValueError:
                pass
    return sorted(out, key=len, reverse=True)


def _long_run(m):
    s = m.group(0)
    if s.count("/") > 2:  # a path, not base64: judge each segment alone
        return re.sub(r"[A-Za-z0-9+=_-]{40,}", _long_run, s)
    # a run of letters with `_` or `-` and no digit is an identifier (a long test name), not a secret
    mixed = re.search(r"[a-z]", s) and re.search(r"[A-Z]", s) and not re.search(r"[_-]", s)
    return REDACTED if re.search(r"[0-9]", s) or mixed else s


PATTERNS = [
    (re.compile(r"-----BEGIN [A-Z0-9 ]*-----.*?(?:-----END [A-Z0-9 ]*-----|\Z)", re.S), lambda m: REDACTED),
    (re.compile(r"-----BEGIN"), lambda m: REDACTED),
    (re.compile(r"(?i)authorization\s*[:=][^\r\n]*"), lambda m: REDACTED),
    (re.compile(r"(?i)\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]*"), lambda m: REDACTED),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]*"), lambda m: REDACTED),
    (re.compile(r"(?i)token[A-Za-z0-9_.-]{0,40}\s{0,4}[:=]\s{0,4}[^\s,;]+"), lambda m: REDACTED),
    (re.compile(r"(?i)\btoken\s+[A-Za-z0-9._~+/=-]{8,}"), lambda m: REDACTED),
    (re.compile(r"[A-Za-z0-9+/=_-]{40,}"), _long_run),
]


def scrub(text, environ):
    text = ANSI.sub("", text)
    for v in secret_values(environ):
        text = text.replace(v, REDACTED)
    for rx, fn in PATTERNS:
        text = rx.sub(fn, text)
    return text


def failed_step(log):
    """(id, exit, command) of the last step the quiet shell saw fail, or None."""
    marks = STEP_MARK.findall(log)
    return marks[-1] if marks else None


def summary(job, log, environ):
    """`job: name, name, name`, else `job failed at step`, else `job failed`; scrubbed, at most 100 characters."""
    # the job and step ids come from the workflow, not the log; the runner's own env (GITHUB_JOB) would blank them
    job = short_name(job, 40)
    names = [short_name(scrub(n, environ), 40) for n in parse_test_names(log)[:3]]
    step = failed_step(log)
    if names:
        line = f"{job}: " + ", ".join(names)
    elif step and step[0] and not step[0].startswith("__"):
        line = f"{job} failed at {short_name(step[0], 30)}"
    else:
        line = f"{job} failed"
    line = line.replace("\n", " ")
    return line if len(line) <= 100 else line[:97] + "..."


def describe_needs(needs):
    """The `ci` status description from the `needs` context: the failed jobs, each with its own summary when it left one."""
    parts = []
    for name, job in needs.items():
        if job.get("result") != "failure":
            continue
        parts.append((job.get("outputs") or {}).get("fail") or f"{name} failed")
    if not parts:
        bad = [f"{n}: {j.get('result')}" for n, j in needs.items() if j.get("result") not in ("success", "skipped")]
        return ", ".join(bad)[:140] or "ci failed"
    line = " | ".join(parts)
    return line if len(line) <= 140 else line[:137] + "..."


def build_comment(sha, job, run_url, log, environ):
    """The comment body. Raises on any problem: the caller then posts nothing."""
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha or ""):
        sha = "unknown"
    clean = scrub(log, environ)
    names = [short_name(scrub(n, environ), 120) for n in parse_test_names(log)[:MAX_NAMES]]
    step = failed_step(clean)
    lines = clean.splitlines()[-TAIL_LINES:]
    head = [f"**{job}** failed on `{sha}`", "", f"Run: {run_url}"]
    if step:
        head.append(f"Failed step: id `{step[0] or '-'}`, exit {step[1]}, `{step[2][:80]}`")
    if names:
        head += ["", "Failing tests:"] + [f"- `{n}`" for n in names]
    tail = "\n".join(lines).replace("```", "'''")
    while True:
        body = "\n".join(head + ["", f"Last {len(lines)} lines of the quiet log:", "", "```", tail, "```"])
        if len(body) <= BODY_BUDGET:
            break
        cut = len(body) - BODY_BUDGET
        tail = "[...cut...]\n" + tail[cut + 16:]
    assert len(body) <= COMMENT_LIMIT
    return body


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("summary")
    s.add_argument("--job", required=True)
    s.add_argument("--log", required=True)
    sub.add_parser("describe-needs")
    c = sub.add_parser("comment")
    c.add_argument("--sha", required=True)
    c.add_argument("--job", required=True)
    c.add_argument("--run-url", required=True)
    c.add_argument("--log", required=True)
    c.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "summary":
        print(summary(a.job, read(a.log), os.environ))
    elif a.cmd == "describe-needs":
        print(describe_needs(json.load(sys.stdin)))
    else:
        body = build_comment(a.sha, a.job, a.run_url, read(a.log), os.environ)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(body)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never a traceback: it could carry log text
        print("ci_failure: failed", file=sys.stderr)
        sys.exit(1)
