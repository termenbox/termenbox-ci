#!/usr/bin/env python3
"""Refuses a manifest that is not exactly what make_manifest.py writes for the build's own files.

usage: check_manifest.py MANIFEST ASSET_DIR VERSION CHANNEL

The signing job runs this before it signs. The manifest and the assets come from jobs that ran the
source's code, so nothing in them is trusted: the key set is fixed, version and channel are the ones this run
was started with, every address is on the download host under channel and version, and every hash is the
SHA-256 of the file in ASSET_DIR.
"""
import hashlib
import json
import re
import sys
import time
from pathlib import Path

BASE = "https://dl.termenbox.dev"
ARCHES = ("x86_64", "aarch64")
NOTICES = ("tmux-COPYING", "tmux-libevent-LICENSE", "tmux-ncurses-COPYING")
TOP = {"version", "channel", "freeze", "issued_at", "notes", "binaries", "tmux", "tmux_notices", "image"}
REQUIRED = {"version", "channel", "freeze", "issued_at", "notes", "binaries", "tmux", "tmux_notices"}


def fail(message):
    sys.exit(f"manifest refused: {message}")


def check_file(entry, name, base, assets):
    if not isinstance(entry, dict) or set(entry) != {"url", "sha256"}:
        fail(f"{name} must hold exactly url and sha256")
    if entry["url"] != f"{base}/{name}":
        fail(f"{name} has the address {entry['url']!r}")
    path = assets / name
    if not path.is_file():
        fail(f"{name} is not among the built files")
    if entry["sha256"] != hashlib.sha256(path.read_bytes()).hexdigest():
        fail(f"{name} does not match its hash")


def check(manifest, assets, version, channel, now=None):
    if not isinstance(manifest, dict):
        fail("not an object")
    extra, missing = set(manifest) - TOP, REQUIRED - set(manifest)
    if extra or missing:
        fail(f"unexpected keys {sorted(extra)}, missing keys {sorted(missing)}")
    if manifest["version"] != version or manifest["channel"] != channel:
        fail("version or channel is not the one of this run")
    if manifest["freeze"] is not False:
        fail("a release is not a freeze")
    issued = manifest["issued_at"]
    if not isinstance(issued, int) or isinstance(issued, bool) or abs(issued - (now or time.time())) > 86400:
        fail("issued_at is not a time within a day of now")
    if not isinstance(manifest["notes"], str):
        fail("notes is not text")
    base = f"{BASE}/{channel}/{version}"
    for group, files in (("binaries", {a: f"termenbox-server-{a}-linux" for a in ARCHES}), ("tmux", {a: f"tmux-{a}-linux" for a in ARCHES}), ("tmux_notices", {n: n for n in NOTICES})):
        section = manifest[group]
        if not isinstance(section, dict) or set(section) != set(files):
            fail(f"{group} must list exactly {sorted(files)}")
        for key, name in files.items():
            check_file(section[key], name, base, assets)
    if "image" in manifest:
        image = manifest["image"]
        if not isinstance(image, dict) or set(image) != set(ARCHES) or not all(isinstance(d, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", d) for d in image.values()):
            fail("image must hold one sha256 digest per architecture")


def main(argv):
    if len(argv) != 5:
        sys.exit(__doc__)
    manifest = json.loads(Path(argv[1]).read_text())
    check(manifest, Path(argv[2]), argv[3], argv[4])
    print("manifest matches the built files")


if __name__ == "__main__":
    main(sys.argv)
