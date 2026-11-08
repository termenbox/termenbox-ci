#!/usr/bin/env python3
"""Tests for freeze_manifest.py: the freeze keeps the channel's downloads, sets the flag, and is newer than the alias."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("freeze_manifest.py")
CURRENT = {"version": "0.2.0", "channel": "stable", "freeze": False, "notes": "n",
           "binaries": {"x86_64": {"url": "https://github.com/termenbox/termenbox/releases/download/v0.2.0/a", "sha256": "0" * 64}}}


def run(current, *args):
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp, "current.json"), Path(tmp, "out.json")
        src.write_text(json.dumps(current))
        r = subprocess.run([sys.executable, str(SCRIPT), str(src), str(out), *args], capture_output=True, text=True)
        return r, (json.loads(out.read_text()) if r.returncode == 0 else None), (out.read_text() if r.returncode == 0 else "")


class FreezeManifest(unittest.TestCase):
    def test_it_keeps_the_downloads_and_sets_the_flag_and_version(self):
        r, m, _ = run(CURRENT, "0.2.1", "stable", "--notes", "paused")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((m["version"], m["freeze"], m["notes"], m["channel"]), ("0.2.1", True, "paused", "stable"))
        self.assertEqual(m["binaries"], CURRENT["binaries"])

    def test_the_output_is_deterministic(self):
        self.assertEqual(run(CURRENT, "0.2.1", "stable")[2], run(CURRENT, "0.2.1", "stable")[2])

    def test_a_version_that_would_not_move_the_alias_is_refused(self):
        for v in ("0.2.0", "0.1.9"):
            self.assertNotEqual(run(CURRENT, v, "stable")[0].returncode, 0, v)

    def test_a_manifest_of_another_channel_is_refused(self):
        nightly = dict(CURRENT, channel="nightly", version="0.2.0-nightly.20261101")
        self.assertNotEqual(run(nightly, "0.2.1", "stable")[0].returncode, 0)

    def test_a_beta_freeze_is_newer_than_the_last_beta(self):
        beta = dict(CURRENT, version="0.3.0-rc.1", channel="beta")
        self.assertEqual(run(beta, "0.3.0-rc.2", "beta")[0].returncode, 0)

    def test_a_beta_freeze_may_replace_a_stable_release_the_beta_alias_holds(self):
        r, m, _ = run(CURRENT, "0.2.1", "beta")
        self.assertEqual((r.returncode, m["channel"]), (0, "beta"))
        self.assertNotEqual(run(CURRENT, "0.2.1", "nightly")[0].returncode, 0)


if __name__ == "__main__":
    unittest.main()
