#!/usr/bin/env python3
"""Tests for r2_retention.py: which version prefixes are kept and which are deleted."""
import unittest

from r2_retention import doomed


class Retention(unittest.TestCase):
    def test_stable_keeps_the_current_and_two_previous(self):
        names = ["0.1.0/", "0.2.0/", "0.2.1/", "0.3.0/", "1.0.0/", "health.txt", "manifest.json", "manifest.json.sig"]
        self.assertEqual(doomed(names, "1.0.0", 2), ["0.2.0", "0.1.0"])

    def test_prereleases_sort_by_semver_and_a_release_beats_its_rc(self):
        names = ["0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "0.1.9"]
        # kept: 0.2.0, then 0.2.0-rc.10 and 0.2.0-rc.2 (rc.10 > rc.2 numerically)
        self.assertEqual(doomed(names, "0.2.0", 2), ["0.2.0-rc.1", "0.1.9"])

    def test_nightly_keeps_the_current_and_four_previous(self):
        names = [f"0.3.0-nightly.202611{d:02d}" for d in range(1, 9)]
        self.assertEqual(doomed(names, "0.3.0-nightly.20261108", 4), ["0.3.0-nightly.20261103", "0.3.0-nightly.20261102", "0.3.0-nightly.20261101"])

    def test_the_current_and_anything_newer_are_never_deleted(self):
        names = ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]
        self.assertEqual(doomed(names, "0.2.0", 0), ["0.1.0"])
        self.assertEqual(doomed(names, "0.2.0", 5), [])

    def test_names_that_are_not_versions_are_ignored(self):
        names = ["health.txt", "manifest.json", "manifest.json.sig", "latest", "0.1.0", "0.2.0", "0.3.0"]
        self.assertEqual(doomed(names, "0.3.0", 1), ["0.1.0"])

    def test_a_current_that_is_not_a_version_is_refused(self):
        with self.assertRaises(SystemExit):
            doomed(["0.1.0"], "latest", 2)


if __name__ == "__main__":
    unittest.main()
