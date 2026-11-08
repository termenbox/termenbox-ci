#!/usr/bin/env python3
"""Which version prefixes of one channel in R2 to delete (decision 0212, free tier: 10 GB).

usage: r2_retention.py CURRENT KEEP_PREVIOUS < names

names are the entries under <channel>/ one per line (a trailing slash is fine). CURRENT is the version the channel's
manifest.json points at. Kept: CURRENT, the KEEP_PREVIOUS highest versions below it, and every version above it (never
guess about something newer than the pointer). Printed, one per line: the older versions that remain. Names that are not a
SemVer version (health.txt, manifest.json, manifest.json.sig) are never printed. CURRENT must be a version.
"""
import sys

import release_plan


def doomed(names, current, keep_previous):
    if not release_plan.SEMVER.fullmatch(current):
        sys.exit(f"current is not a version: {current!r}")
    versions = {n.strip().rstrip("/") for n in names}
    versions = {v for v in versions if release_plan.SEMVER.fullmatch(v)}
    below = sorted((v for v in versions if release_plan.newer(current, v)), key=release_plan.key, reverse=True)
    return below[keep_previous:]


def main(argv):
    if len(argv) != 3 or not argv[2].isdigit():
        sys.exit(__doc__)
    for v in doomed(sys.stdin.read().split(), argv[1], int(argv[2])):
        print(v)


if __name__ == "__main__":
    main(sys.argv)
