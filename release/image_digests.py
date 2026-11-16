#!/usr/bin/env python3
"""Resolves the per-architecture image digests of a release for the signed manifest.

usage: image_digests.py IMAGE_REF OUT --commit SHA --run-start TIME

IMAGE_REF is the multi-architecture tag docker-build.yaml pushed for the release (ghcr.io/termenbox/termenbox:1.2.3).
OUT receives {"x86_64": "sha256:...", "aarch64": "sha256:..."}, the digests of the two linux images the tag lists. The
image is built by a job this one needs (release-build.yaml), so the tag exists when this runs and is read once. Both
architectures are required; a tag that lists only one is not written.

The digests must come from this release's own image build. Every architecture image the tag lists is read and refused
unless its org.opencontainers.image.revision label equals --commit and it was created at or after --run-start, the start
of this run. A tag that holds an older image, or one of another commit, is refused and nothing is written; so is a start
that cannot be read.
"""
import argparse
import datetime
import json
import re
import subprocess
import sys

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
    parser.add_argument("--run-start", required=True)
    opts = parser.parse_args(argv[1:])
    ref, out = opts.ref, opts.out
    try:
        digests = digests_from_index(inspect(ref))
        problem = own_build_problem(ref, digests, opts.commit, opts.run_start)
        if problem is not None:
            raise ValueError(f"not this release's own image build ({problem})")
    except ValueError as e:
        sys.exit(f"{ref}: {e}")
    with open(out, "w") as f:
        json.dump(digests, f, sort_keys=True, indent=2)
        f.write("\n")
    print(f"wrote {out}: {digests}")


if __name__ == "__main__":
    main(sys.argv)
