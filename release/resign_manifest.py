#!/usr/bin/env python3
"""Writes the manifest of a re-sign: the channel's current manifest, unchanged except for a fresh "issued_at".

usage: resign_manifest.py CURRENT OUT CHANNEL [--now SECONDS]

CURRENT is the manifest the channel's pointer holds now. A signed manifest is accepted for 90 days after it was issued, so
a channel that has no release for a while must be signed again before the window ends. The output keeps the version, the
downloads, the hashes and the "freeze" flag exactly as they are (a re-sign neither lifts a freeze nor moves a version) and
only states a later issue time. Sign it with sign_manifest.sh and write it with `publish_r2.sh --resign`.
"""
import json
import sys
import time
from pathlib import Path

CHANNELS = ("stable", "beta", "nightly")


def resign(current, channel, now):
    if channel not in CHANNELS:
        sys.exit(f"channel must be one of {', '.join(CHANNELS)}, got {channel!r}")
    # The channel is part of what is signed and stays: a stable manifest on the beta pointer is signed again by the
    # stable key (offline), never by the beta key.
    held = current.get("channel", "stable")
    if held != channel:
        sys.exit(f"the current manifest is a {held} manifest, not a {channel} one")
    before = current.get("issued_at")
    if isinstance(before, int) and now <= before:
        sys.exit(f"the clock ({now}) is not after the current issue time ({before})")
    out = dict(current)
    out["issued_at"] = now
    return out


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    now = int(time.time())
    if "--now" in argv:
        now = int(argv[argv.index("--now") + 1])
        args = [a for a in args if a != str(now)]
    if len(args) != 3:
        sys.exit(__doc__)
    current_path, out_path, channel = args
    manifest = resign(json.loads(Path(current_path).read_text()), channel, now)
    Path(out_path).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    print(f"wrote {out_path}: {channel} {manifest['version']} signed again at {now}")


if __name__ == "__main__":
    main(sys.argv)
