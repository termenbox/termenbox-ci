#!/usr/bin/env python3
"""What a release tag means. One place decides the channel, the version, the image tags
and the alias releases, because GitHub tag globs are not regexes: `v[0-9]*.[0-9]*.[0-9]*` also matches `v0.2.0-rc.1`.

usage: release_plan.py tag TAG                    classify a pushed tag; prints JSON, channel `none` for any other tag
       release_plan.py nightly CORE YYYYMMDD [N]  the Nth nightly of a day (default 1), CORE is the version in Cargo.toml
       release_plan.py newer CANDIDATE CURRENT    exit 0 when CANDIDATE is the newer SemVer (build metadata ignored)
       release_plan.py thaws CANDIDATE MANIFEST   exit 0 when MANIFEST (a channel's published manifest.json) is not a
                                                  freeze, or CANDIDATE is newer than it; exit 1 while the freeze holds

JSON: channel, tag, version (the manifest version), core, docker_tags, aliases (rolling releases that may point at
this release), prerelease (a GitHub prerelease), latest (GitHub's "latest" release).
"""
import json
import re
import sys

NUM = r"(0|[1-9]\d*)"
CORE = rf"{NUM}\.{NUM}\.{NUM}"
STABLE = re.compile(rf"^v({CORE})$")
BETA = re.compile(rf"^v({CORE})-((?:rc|beta)\.{NUM})$")
SEMVER = re.compile(rf"^{CORE}(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def plan(channel, tag, version, core, docker_tags, aliases, prerelease, latest):
    return {
        "channel": channel, "tag": tag, "version": version, "core": core,
        "docker_tags": docker_tags, "aliases": aliases, "prerelease": prerelease, "latest": latest,
    }


def from_tag(tag):
    if m := STABLE.match(tag):
        version = m.group(1)
        major, minor = m.group(2), m.group(3)
        # A stable release is also what a beta server follows when it is newer than the last beta.
        return plan("stable", tag, version, version, ["latest", f"{major}.{minor}", version], ["channel-beta"], False, True)
    if m := BETA.match(tag):
        version = tag[1:]
        return plan("beta", tag, version, m.group(1), ["beta", version], ["channel-beta"], True, False)
    # A nightly tag is not classified here: release-nightly.yaml makes them and knows the core version.
    return plan("none", tag, "", "", [], [], False, False)


def nightly(core, day, n=1):
    """The first nightly of a day keeps its plain name; the Nth after it adds `.N`, which SemVer orders after it
    (`nightly.20261106` < `nightly.20261106.2` < `nightly.20261107`), so any number of nightlies can follow in a day."""
    if not re.fullmatch(CORE, core) or not re.fullmatch(r"\d{8}", day) or not isinstance(n, int) or n < 1:
        sys.exit("nightly needs CORE (X.Y.Z), YYYYMMDD and optionally N >= 1")
    suffix = f".{n}" if n > 1 else ""
    tag = f"v{day[:4]}.{day[4:6]}.{day[6:]}-nightly{suffix}"
    version = f"{core}-nightly.{day}{suffix}"
    return plan("nightly", tag, version, core, ["nightly", version], ["channel-nightly"], True, False)


def key(version):
    """SemVer precedence: core numbers, then no prerelease beats any prerelease, then identifiers left to right."""
    m = SEMVER.match(version)
    if not m:
        sys.exit(f"not a SemVer version: {version}")
    core = tuple(int(x) for x in m.groups()[:3])
    pre = m.group(4)
    if pre is None:
        return core, (1,)
    # numeric identifiers sort below alphanumeric ones, and a shorter list below a longer one it prefixes
    ids = tuple((0, int(i), "") if i.isdigit() else (1, 0, i) for i in pre.split("."))
    return core, (0, ids)


def newer(candidate, current):
    return key(candidate) > key(current)


def thaws(candidate, manifest_path):
    """A freeze is a signed manifest the channel's alias points at. A release is let through only when it would
    replace that manifest (the aliases only move forward), so a frozen channel needs a release newer than the freeze."""
    with open(manifest_path) as f:
        manifest = json.load(f)
    return manifest.get("freeze") is not True or newer(candidate, manifest["version"])


def main(argv):
    if len(argv) == 3 and argv[1] == "tag":
        print(json.dumps(from_tag(argv[2])))
    elif len(argv) in (4, 5) and argv[1] == "nightly":
        if len(argv) == 5 and not (argv[4].isascii() and argv[4].isdigit()):
            sys.exit("nightly N must be a number")
        print(json.dumps(nightly(argv[2], argv[3], int(argv[4]) if len(argv) == 5 else 1)))
    elif len(argv) == 4 and argv[1] == "newer":
        return 0 if newer(argv[2], argv[3]) else 1
    elif len(argv) == 4 and argv[1] == "thaws":
        return 0 if thaws(argv[2], argv[3]) else 1
    else:
        sys.exit(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
