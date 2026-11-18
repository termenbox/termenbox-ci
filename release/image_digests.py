#!/usr/bin/env python3
"""Resolves the per-architecture image digests of a release for the signed manifest.

usage: image_digests.py IMAGE_REF OUT --commit SHA --run-id ID

IMAGE_REF is the multi-architecture tag docker-build.yaml pushed for the release (ghcr.io/termenbox/termenbox:1.2.3).
OUT receives {"x86_64": "sha256:...", "aarch64": "sha256:..."}, the digests of the two linux images the tag lists. The
image is built by a job this one needs (release-build.yaml), so the tag exists when this runs and is read once. Both
architectures are required; a tag that lists only one is not written.

The digests must come from this release's own image build. Every architecture image the tag lists is read and refused
unless its org.opencontainers.image.revision label equals --commit and its dev.termenbox.release.run label equals
--run-id, the id of this workflow run, which docker-build.yaml writes into every image it pushes. A tag that holds an
image of another commit or of another run is refused and nothing is written. The creation time is not used: a retry
of a built commit is served from the build cache and keeps its old time.
"""
import argparse
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
RUN = "dev.termenbox.release.run"


def image_problem(config, commit, run_id):
    """Why this image config is not the build of this release, or None. Neutral on purpose."""
    labels = (config.get("config") or {}).get("Labels") or {}
    if labels.get(REVISION) != commit:
        return "its revision label is not the release commit"
    if not run_id or labels.get(RUN) != str(run_id):
        return "its run label is not this run"
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


def own_build_problem(ref, digests, commit, run_id):
    """The first reason one of the architecture images is not this release's own build, or None."""
    base = ref.rsplit(":", 1)[0] if ":" in ref.rsplit("/", 1)[-1] else ref
    for arch, digest in sorted(digests.items()):
        try:
            problem = image_problem(image_config(f"{base}@{digest}"), commit, run_id)
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
    parser.add_argument("--run-id", required=True)
    opts = parser.parse_args(argv[1:])
    ref, out = opts.ref, opts.out
    try:
        digests = digests_from_index(inspect(ref))
        problem = own_build_problem(ref, digests, opts.commit, opts.run_id)
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
