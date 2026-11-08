#!/usr/bin/env python3
"""Tests for resign_manifest.py: only the issue time changes; a freeze stays a freeze; the clock cannot go back."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("resign_manifest.py")
CURRENT = {"version": "0.2.0-beta.1", "channel": "beta", "freeze": False, "issued_at": 1000, "notes": "n",
           "binaries": {"x86_64": {"url": "https://dl.termenbox.dev/beta/0.2.0-beta.1/a", "sha256": "0" * 64}}}


def run(current, *args):
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp, "current.json"), Path(tmp, "out.json")
        src.write_text(json.dumps(current))
        r = subprocess.run([sys.executable, str(SCRIPT), str(src), str(out), *args], capture_output=True, text=True)
        return r, (json.loads(out.read_text()) if r.returncode == 0 else None)


class ResignManifest(unittest.TestCase):
    def test_only_the_issue_time_changes(self):
        r, m = run(CURRENT, "beta", "--now", "5000")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(m, {**CURRENT, "issued_at": 5000})

    def test_a_freeze_stays_a_freeze(self):
        r, m = run({**CURRENT, "freeze": True}, "beta", "--now", "5000")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(m["freeze"])

    def test_a_manifest_without_an_issue_time_gets_one(self):
        old = {k: v for k, v in CURRENT.items() if k != "issued_at"}
        r, m = run(old, "beta", "--now", "5000")
        self.assertEqual((r.returncode, m["issued_at"]), (0, 5000))

    def test_the_clock_cannot_go_back(self):
        r, _ = run(CURRENT, "beta", "--now", "1000")
        self.assertNotEqual(r.returncode, 0)

    def test_another_channels_manifest_is_refused(self):
        for held, channel in (("beta", "nightly"), ("stable", "beta")):
            r, _ = run({**CURRENT, "channel": held}, channel, "--now", "5000")
            self.assertNotEqual(r.returncode, 0, (held, channel))


if __name__ == "__main__":
    unittest.main()
