#!/usr/bin/env python3
"""Writes the manifest of a freeze: the channel's current manifest with "freeze" set and a newer version.

usage: freeze_manifest.py CURRENT OUT VERSION CHANNEL [--notes TEXT]

CURRENT is the manifest the channel's alias holds now. The freeze keeps its download addresses and hashes (they are
project release URLs, which the updater checks), takes VERSION and CHANNEL, and sets "freeze": true. VERSION must be newer than
CURRENT's, because the aliases only move forward (update_alias.sh); an updater or the installer that reads a frozen
manifest stops before it compares versions. The output is signed by the channel's release key, like any manifest, and
carries a fresh "issued_at".
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import release_plan  # noqa: E402

CHANNELS = ("stable", "beta", "nightly")


def freeze(current, version, channel, notes=""):
    if channel not in CHANNELS:
        sys.exit(f"channel must be one of {', '.join(CHANNELS)}, got {channel!r}")
    # The beta alias can hold a stable release (decision 0132), which a beta freeze then replaces under the beta key.
    held = current.get("channel", "stable")
    if held != channel and not (channel == "beta" and held == "stable"):
        sys.exit(f"the current manifest is a {held} manifest, not a {channel} one")
    if not release_plan.SEMVER.match(version):
        sys.exit(f"version must look like 1.2.3 or 1.2.3-beta.1, got {version!r}")
    if not release_plan.newer(version, current["version"]):
        sys.exit(f"{version} is not newer than {current['version']}: the alias would not move")
    out = dict(current)
    out.update({"version": version, "channel": channel, "freeze": True, "issued_at": int(time.time()), "notes": notes})
    return out


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    notes = ""
    if "--notes" in argv:
        notes = argv[argv.index("--notes") + 1]
        args = [a for a in args if a != notes]
    if len(args) != 4:
        sys.exit(__doc__)
    current_path, out_path, version, channel = args
    manifest = freeze(json.loads(Path(current_path).read_text()), version, channel, notes)
    Path(out_path).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    print(f"wrote {out_path}: {channel} frozen at {version}")


if __name__ == "__main__":
    main(sys.argv)
