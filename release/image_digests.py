#!/usr/bin/env python3
"""Resolves the per-architecture image digests of a release for the signed manifest.

usage: image_digests.py IMAGE_REF OUT --commit SHA [--run-start TIME] [--wait SECONDS] [--build-jobs PREFIX | --build-run TITLE]

IMAGE_REF is the multi-architecture tag docker-build.yaml pushed for the release (ghcr.io/termenbox/termenbox:1.2.3).
OUT receives {"x86_64": "sha256:...", "aarch64": "sha256:..."}, the digests of the two linux images the tag lists. The
tag is pushed by a workflow that runs beside the release, so the image may not exist yet: --wait polls for it until
the time is up. Both architectures are required; a tag that lists only one is not written.

While it waits, it asks whether the image build has already ended without an image, so a failed build is reported at once
instead of after the whole wait (which stays as the backstop):
  --build-jobs PREFIX  the image is built by jobs of this run (a nightly): any job of the run whose name starts with PREFIX
                       ("Image / ") that failed or was cancelled ends the wait. Reads GITHUB_REPOSITORY and GITHUB_RUN_ID.
  --build-run TITLE    the image is built by a separate docker-build run (a stable or beta tag): the newest run of
                       docker-build.yaml titled TITLE ("Image v1.2.3", its run-name) that failed or was cancelled ends it.
A lookup that fails or finds nothing changes nothing: the wait goes on.

The digests must come from this release's own image build. Every architecture image the tag lists is read and refused
unless its org.opencontainers.image.revision label equals --commit and it was created at or after the start of the
build run (--run-start, else the start of the --build-run run or of this run for --build-jobs). A tag that holds an
older image, or one of another commit, is treated like an absent tag: the wait goes on, and at the end nothing is
written. When the start of the run cannot be read, nothing is written either.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

PLATFORMS = {"amd64": "x86_64", "arm64": "aarch64"}
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def digests_from_index(index):
    """The digest per architecture from an image index; attestation entries (platform unknown) are skipped."""
    found = {}
    for entry in index.get("manifests", []):
        platform = entry.get("platform", {})
        arch = PLATFORMS.get(platform.get("architecture"))
        digest = entry.get("digest", "")
        if platform.get("os") != "linux" or arch is None or not DIGEST.fullmatch(digest):
            continue
        if arch in found and found[arch] != digest:
            raise ValueError(f"the tag lists two different {arch} images")
        found[arch] = digest
    missing = sorted(set(PLATFORMS.values()) - set(found))
    if missing:
        raise ValueError(f"the tag has no linux image for {', '.join(missing)}")
    return found


def inspect(ref):
    run = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--raw", ref], capture_output=True, text=True)
    if run.returncode != 0:
        raise ValueError(run.stderr.strip() or "inspect failed")
    return json.loads(run.stdout)


REVISION = "org.opencontainers.image.revision"
FRACTION = re.compile(r"\.(\d{6})\d*")


def parse_time(text):
    """A UTC datetime from an RFC 3339 time (nanoseconds allowed), or None."""
    try:
        when = datetime.datetime.fromisoformat(FRACTION.sub(r".\1", str(text)).replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else None


def image_problem(config, commit, started):
    """Why this image config is not the build of this release, or None. Neutral on purpose."""
    if (config.get("config") or {}).get("Labels", {}).get(REVISION) != commit:
        return "its revision label is not the release commit"
    made, began = parse_time(config.get("created")), parse_time(started)
    if began is None:
        return "the start of the image build run is unknown"
    if made is None:
        return "its creation time is unreadable"
    if made < began:
        return "it was created before the image build run started"
    return None


def image_config(ref):
    """The config (created time, labels) of one single-architecture image."""
    run = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Image}}", ref], capture_output=True, text=True)
    if run.returncode != 0:
        raise ValueError(run.stderr.strip() or "inspect failed")
    data = json.loads(run.stdout)
    if isinstance(data, dict) and "config" not in data and "created" not in data and len(data) == 1:
        data = next(iter(data.values()))
    return data if isinstance(data, dict) else {}


def run_start(runs, title):
    """run_started_at of the newest run with this title, else None."""
    same = [r for r in runs if r.get("display_title") == title]
    return max(same, key=lambda r: r.get("id", 0)).get("run_started_at") if same else None


ENDED_BADLY = {"failure", "cancelled", "timed_out", "startup_failure"}


def failed_job(jobs, prefix):
    """(name, conclusion) of the first job of the run whose name starts with prefix and ended badly, else None."""
    for job in jobs:
        name = job.get("name", "")
        if name.startswith(prefix) and job.get("conclusion") in ENDED_BADLY:
            return name, job["conclusion"]
    return None


def failed_run(runs, title):
    """(title, conclusion) when the newest run with this title ended badly, else None. A re-run reuses its run, so the
    newest run's conclusion is the latest attempt's."""
    same = [r for r in runs if r.get("display_title") == title]
    if not same:
        return None
    newest = max(same, key=lambda r: r.get("id", 0))
    return (title, newest["conclusion"]) if newest.get("conclusion") in ENDED_BADLY else None


def api(path):
    run = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if run.returncode != 0:
        return None
    try:
        return json.loads(run.stdout)
    except ValueError:
        return None


def build_failure(opts):
    """What ended the image build without an image, or None (still going, unknown, or not asked)."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if opts.build_jobs is not None:
        data = api(f"repos/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}/jobs?per_page=100")
        return failed_job((data or {}).get("jobs", []), opts.build_jobs)
    if opts.build_run is not None:
        data = api(f"repos/{repo}/actions/workflows/docker-build.yaml/runs?per_page=50")
        return failed_run((data or {}).get("workflow_runs", []), opts.build_run)
    return None


def build_start(opts):
    """When the image build run started: --run-start, else read from the run that builds this release, else None."""
    if opts.run_start:
        return opts.run_start
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if opts.build_jobs is not None:
        data = api(f"repos/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}")
        return (data or {}).get("run_started_at")
    if opts.build_run is not None:
        data = api(f"repos/{repo}/actions/workflows/docker-build.yaml/runs?per_page=50")
        return run_start((data or {}).get("workflow_runs", []), opts.build_run)
    return None


def own_build_problem(ref, digests, commit, started):
    """The first reason one of the architecture images is not this release's own build, or None."""
    base = ref.rsplit(":", 1)[0] if ":" in ref.rsplit("/", 1)[-1] else ref
    for arch, digest in sorted(digests.items()):
        try:
            problem = image_problem(image_config(f"{base}@{digest}"), commit, started)
        except ValueError as e:
            problem = str(e)
        if problem:
            return f"{arch}: {problem}"
    return None


def main(argv):
    parser = argparse.ArgumentParser(usage=__doc__)
    parser.add_argument("ref")
    parser.add_argument("out")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--run-start")
    parser.add_argument("--wait", type=int, default=0)
    parser.add_argument("--build-jobs")
    parser.add_argument("--build-run")
    opts = parser.parse_args(argv[1:])
    ref, out = opts.ref, opts.out
    deadline = time.monotonic() + opts.wait
    while True:
        try:
            digests = digests_from_index(inspect(ref))
            problem = own_build_problem(ref, digests, opts.commit, build_start(opts))
            if problem is None:
                break
            raise ValueError(f"not this release's own image build ({problem})")
        except ValueError as e:
            if time.monotonic() >= deadline:
                sys.exit(f"{ref}: {e}")
            ended = build_failure(opts)
            if ended:
                sys.exit(f"{ref}: the image build ({ended[0]}) ended as {ended[1]}, so there is no image to wait for")
            print(f"waiting for {ref}: {e}", flush=True)
            time.sleep(30)
    with open(out, "w") as f:
        json.dump(digests, f, sort_keys=True, indent=2)
        f.write("\n")
    print(f"wrote {out}: {digests}")


if __name__ == "__main__":
    main(sys.argv)
