#!/usr/bin/env python3
"""Refuses a SHA256SUMS that is not exactly the hashes of the release files.

usage: check_sums.py SHA256SUMS DIR MANIFEST

The job that signs SHA256SUMS runs this first. The file was written by a job that ran the source's code, so nothing
in it is trusted: the names are a fixed set (install.sh is optional), every hash is recomputed from the file in DIR,
and the line for manifest.json is the hash of MANIFEST, the manifest the signing job signed.
"""
import hashlib
import re
import sys
from pathlib import Path

ARCHES = ("x86_64", "aarch64")
REQUIRED = (
    [f"termenbox-server-{a}-linux" for a in ARCHES]
    + [f"tmux-{a}-linux" for a in ARCHES]
    + ["tmux-COPYING", "tmux-libevent-LICENSE", "tmux-ncurses-COPYING", "LICENSE", "NOTICES", "manifest.json", "manifest.json.sig"]
)
OPTIONAL = ("install.sh",)
LINE = re.compile(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)")


def fail(message):
    sys.exit(f"SHA256SUMS refused: {message}")


def check(sums_text, directory, manifest_path):
    entries = {}
    for line in sums_text.splitlines():
        m = LINE.fullmatch(line)
        if not m:
            fail(f"a line is not '<sha256>  <name>': {line[:60]!r}")
        digest, name = m.groups()
        if name in entries:
            fail(f"{name} is listed twice")
        entries[name] = digest
    names = set(entries)
    missing = set(REQUIRED) - names
    extra = names - set(REQUIRED) - set(OPTIONAL)
    if missing or extra:
        fail(f"unexpected names {sorted(extra)}, missing names {sorted(missing)}")
    for name, digest in entries.items():
        path = Path(directory) / name
        if not path.is_file():
            fail(f"{name} is not among the release files")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            fail(f"{name} does not match its hash")
    if entries["manifest.json"] != hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest():
        fail("manifest.json is not the manifest that was signed")


def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    check(Path(argv[1]).read_text(), argv[2], argv[3])
    print("SHA256SUMS matches the release files")


if __name__ == "__main__":
    main(sys.argv)
